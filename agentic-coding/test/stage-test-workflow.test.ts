import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { JsonValue, WorkflowSnapshot } from "../src/contracts/workflow.ts";
import { listEvidence } from "../src/server/evidence/store.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { managedWorkflowTarget } from "../src/workflow/cli/caller-environment.ts";
import { WorkflowRuntimeError } from "../src/workflow/contracts.ts";
import {
	stageTestPlan,
	stageTestReport,
} from "../src/workflow/definitions/contracts.ts";
import { stageTestManifests } from "../src/workflow/definitions/graphs/stage-test.ts";
import { WORKFLOW_STEPS } from "../src/workflow/definitions/steps.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	effectRunnerTest,
} from "../src/workflow/effect-runner.ts";
import {
	workflowEvidenceRoot,
	workflowEvidenceScope,
} from "../src/workflow/runtime/evidence-store.ts";
import { stageTestWorkflowTarget } from "../src/workflow/runtime.ts";
import {
	stageReportIssues,
	stageTestBehaviors,
} from "../src/workflow/steps/stage-test.ts";

const plan = (overrides: Record<string, unknown> = {}) => ({
	ticketSummary: "Check request status",
	knowledgeStatus: "none",
	expectations: [
		{
			id: "E1",
			statement: "The request is visible",
			source: "ticket",
			priority: "high",
		},
	],
	knowledgeUsed: [],
	route: [
		{
			id: "R1",
			application: "web",
			action: "open the request",
			expected: "Request details are visible",
			capture: [],
		},
	],
	asyncWaits: [],
	createsData: false,
	dataCreated: [],
	notTested: [],
	...overrides,
});

const report = (overrides: Record<string, unknown> = {}) => ({
	expectations: [
		{
			id: "E1",
			verdict: "pass",
			expected: "The request is visible",
			observed: "The request is visible",
			stepIds: ["1"],
			evidenceIds: ["ev-1"],
		},
	],
	applicationVersions: [
		{ application: "web", status: "available", version: "1.2.3" },
	],
	createdData: [],
	knowledgeObservations: [],
	notTested: [],
	...overrides,
});

function snapshot(metadata: Record<string, unknown>): WorkflowSnapshot {
	return {
		workflowId: "stage-flow",
		revision: 2,
		definition: {
			id: "stage-test",
			version: 1,
			digest: "pin",
			label: "Stage test",
		},
		metadata: { stage: "grid-int", ...metadata },
		evidence: [],
	} as unknown as WorkflowSnapshot;
}

function completeAgentStep(
	stepId: "stage.plan" | "stage.execute",
	current: WorkflowSnapshot,
	output: unknown,
	stage: {
		stageJournal?: readonly {
			seq: number;
			knowledge?: { concept: string; kind: string };
		}[];
		stageApps?: readonly string[];
		stageEvidenceIds?: readonly string[];
	} = {},
) {
	const complete = stageTestBehaviors[stepId]?.onAgentComplete;
	if (!complete) throw new Error(`missing ${stepId} completion behavior`);
	return complete({
		snapshot: current,
		definitionId: "stage-test",
		hasStep: () => true,
		run: {
			id: "run",
			role: stepId === "stage.plan" ? "stage-planner" : "stage-tester",
			stepId,
		},
		outcome: "complete",
		remainingActiveRunIds: [],
		evidence: current.evidence,
		output: output as JsonValue,
		...stage,
	});
}

describe("stage-test planning and report contracts", () => {
	test("the tester role is single-classified and requires vision", () => {
		const execute = WORKFLOW_STEPS.find(({ id }) => id === "stage.execute");
		expect(execute?.behavior?.classification).toBe("single");
		expect(execute?.requirements).toContain("vision");
	});

	test("plan approval policies route always, when-writing and never in the engine", () => {
		const dataCreating = plan({
			createsData: true,
			dataCreated: ["one test request"],
		});
		expect(
			completeAgentStep(
				"stage.plan",
				snapshot({ stageAccess: "read-only", stagePlanApproval: "always" }),
				plan(),
			)?.transition?.outcome,
		).toBe("needs-approval");
		expect(
			completeAgentStep(
				"stage.plan",
				snapshot({ stageAccess: "writable", stagePlanApproval: "never" }),
				dataCreating,
			)?.transition?.outcome,
		).toBe("execute");
	});

	test("the engine routes a writable data-creating plan through approval", () => {
		const result = completeAgentStep(
			"stage.plan",
			snapshot({ stageAccess: "writable", stagePlanApproval: "when-writing" }),
			plan({ createsData: true, dataCreated: ["one test request"] }),
		);
		expect(result?.transition?.outcome).toBe("needs-approval");
	});

	test("a read-only plan continues directly and cannot claim data creation", () => {
		const direct = completeAgentStep(
			"stage.plan",
			snapshot({ stageAccess: "read-only", stagePlanApproval: "when-writing" }),
			plan(),
		);
		expect(direct?.transition?.outcome).toBe("execute");
		expect(() =>
			completeAgentStep(
				"stage.plan",
				snapshot({ stageAccess: "read-only", stagePlanApproval: "always" }),
				plan({ createsData: true, dataCreated: ["one test request"] }),
			),
		).toThrow(WorkflowRuntimeError);
	});

	test("an application version may be explicitly unavailable with a reason", () => {
		const result = completeAgentStep(
			"stage.execute",
			snapshot({ stageTestPlan: plan() }),
			report({
				applicationVersions: [
					{
						application: "web",
						status: "unavailable",
						reason: "version probe did not resolve",
					},
				],
			}),
		);
		expect(result?.effects?.map((effect) => effect.kind)).toContain(
			"stage.report.render",
		);
	});

	test("the report renderer deterministically summarizes the plan and evidence", () => {
		const rendered = effectRunnerTest.renderStageReport(
			"grid-int",
			"GRID-42",
			{
				environment: "integration",
				system: "grid-allocation",
				access: "read-only",
			},
			stageTestPlan.parse(plan()),
			stageTestReport.parse(report()),
			[
				{
					seq: 1,
					at: "2026-04-01T12:00:00Z",
					app: "web",
					role: "clerk",
					label: "open the request",
					expected: "Request details are visible",
					observed: "Request details are visible",
				},
			],
			[
				{
					id: "ev-1",
					kind: "screenshot",
					file: "ev-1.png",
					caption: "Request details",
					createdAt: "2026-04-01T12:00:00Z",
				},
			],
			"2026-04-01T12:01:00Z",
		);
		expect(rendered).toContain("# Stage test report");
		expect(rendered).toContain("**Overall:** PASS");
		expect(rendered).toContain("GRID-42");
		expect(rendered).toContain("Step 1 (web / clerk): open the request");
		expect(rendered).toContain("ev-1: Request details");
	});

	test("a pass without evidence is refused before report rendering", () => {
		expect(() =>
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: plan() }),
				report({
					expectations: [
						{
							id: "E1",
							verdict: "pass",
							expected: "The request is visible",
							observed: "The request is visible",
							stepIds: ["1"],
							evidenceIds: [],
						},
					],
				}),
			),
		).toThrow(/must cite evidence/);
	});

	test("the graph bounds follow-ups and routes report choices explicitly", () => {
		const definition = stageTestManifests(1)[0];
		if (!definition) throw new Error("missing stage-test manifest");
		expect(definition.edges).toContainEqual({
			from: "stage.review",
			outcome: "approve-and-update-wiki",
			to: "core.wiki",
		});
		expect(definition.edges).toContainEqual({
			from: "stage.review",
			outcome: "comments",
			to: "stage.execute",
			loop: { maxAttempts: 3 },
		});
	});

	test("wiki write-back is offered only for non-confirmed observations", () => {
		const actions = stageTestBehaviors["stage.review"]?.developerActions;
		if (!actions) throw new Error("missing stage.review actions");
		const base = snapshot({ stageTestReport: report() });
		const confirmed = actions({ snapshot: base });
		expect(confirmed.map(({ id }) => id)).not.toContain(
			"approve-and-update-wiki",
		);
		const update = actions({
			snapshot: snapshot({
				stageTestReport: report({
					knowledgeObservations: [
						{ concept: "grid-connection-request", kind: "missing" },
					],
				}),
			}),
		});
		expect(update.map(({ id }) => id)).toContain("approve-and-update-wiki");
	});
	test("the plan contract enforces its cross-field rules", () => {
		const parse = (overrides: Record<string, unknown>) =>
			stageTestPlan.parse({ ...plan(), ...overrides });
		expect(() => parse({ dataCreated: ["one request"] })).toThrow();
		expect(() => parse({ createsData: true, dataCreated: [] })).toThrow();
		expect(() =>
			parse({
				knowledgeStatus: "none",
				knowledgeUsed: [
					{ concept: "grid-connection-request", trustTier: "unverified" },
				],
			}),
		).toThrow();
		expect(() => parse({ knowledgeStatus: "found" })).toThrow();
		const duplicateExpectations = plan().expectations as unknown as unknown[];
		expect(() =>
			parse({
				expectations: [duplicateExpectations[0], duplicateExpectations[0]],
			}),
		).toThrow();
		const duplicateRoute = plan().route as unknown as unknown[];
		expect(() =>
			parse({ route: [duplicateRoute[0], duplicateRoute[0]] }),
		).toThrow();
		expect(
			parse({ createsData: true, dataCreated: ["one request"] }),
		).toBeTruthy();
	});

	test("the report guard refuses a mismatched verdict set and an invalid citation", () => {
		const current = snapshot({ stageTestPlan: plan() });
		const cases: [Record<string, unknown>, RegExp][] = [
			[
				{
					expectations: [
						{
							id: "E2",
							verdict: "pass",
							expected: "x",
							observed: "y",
							stepIds: ["1"],
							evidenceIds: ["ev-1"],
						},
					],
				},
				/exactly one verdict/,
			],
			[
				{
					expectations: [
						{
							id: "E1",
							verdict: "fail",
							expected: "x",
							observed: "y",
							stepIds: ["1"],
							evidenceIds: ["ev-1"],
						},
					],
				},
				/must include severity/,
			],
			[
				{
					expectations: [
						{
							id: "E1",
							verdict: "pass",
							expected: "x",
							observed: "y",
							stepIds: ["abc"],
							evidenceIds: ["ev-1"],
						},
					],
				},
				/invalid stage step id/,
			],
		];
		for (const [overrides, message] of cases)
			expect(() =>
				completeAgentStep("stage.execute", current, report(overrides)),
			).toThrow(message);
	});

	test("the report schema refuses one verdict covering two planned expectations", () => {
		const twoExpectations = plan({
			expectations: [
				{
					id: "E1",
					statement: "The request is visible",
					source: "ticket",
					priority: "high",
				},
				{
					id: "E2",
					statement: "The request can be approved",
					source: "ticket",
					priority: "high",
				},
			],
		});
		const verdict = {
			id: "E1",
			verdict: "pass",
			expected: "The request is visible",
			observed: "The request is visible",
			stepIds: ["1"],
			evidenceIds: ["ev-1"],
		};
		// Two verdicts against two planned ids: only the distinct ids show that E2
		// was never executed, so a count alone would accept this report. The report
		// schema owns that rule and refuses the duplicate while parsing, before the
		// entry guard runs, so this pins the schema rather than the guard (whose
		// count and membership check is the one above).
		expect(() =>
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: twoExpectations }),
				report({ expectations: [verdict, { ...verdict }] }),
			),
		).toThrow(/expectation ids must be unique/);
	});

	test("a report is refused when its versions, evidence, steps, knowledge or secrets do not line up", () => {
		const journal = [
			{
				seq: 1,
				knowledge: { concept: "grid-connection-request", kind: "missing" },
			},
		];
		const issues = (
			overrides: Record<string, unknown>,
			input: Record<string, unknown> = {},
		) =>
			stageReportIssues({
				plan: stageTestPlan.parse(plan()),
				report: stageTestReport.parse(report(overrides)),
				journal,
				evidenceIds: ["ev-1"],
				declaredApps: ["web"],
				...input,
			});
		expect(issues({}, { declaredApps: ["web", "api"] })).toContain(
			"stage report must include one version status for every declared application",
		);
		expect(
			issues({
				expectations: [
					{
						id: "E1",
						verdict: "pass",
						expected: "x",
						observed: "y",
						stepIds: ["1"],
						evidenceIds: ["ev-999"],
					},
				],
			}),
		).toContain(
			"stage report expectation E1 cites evidence that is not attached to this workflow",
		);
		expect(
			issues({
				expectations: [
					{
						id: "E1",
						verdict: "pass",
						expected: "x",
						observed: "y",
						stepIds: ["99"],
						evidenceIds: ["ev-1"],
					},
				],
			}),
		).toContain(
			"stage report expectation E1 cites a stage journal step that does not exist",
		);
		expect(
			issues({
				knowledgeObservations: [
					{ concept: "grid-connection-request", kind: "new" },
				],
			}),
		).toContain(
			"stage report knowledge observation grid-connection-request is not supported by the stage journal",
		);
		expect(issues({}, { secrets: ["The request is visible"] })).toContain(
			"stage report contains a configured secret; remove it and retry without including credential values",
		);
	});

	test("the report renderer aggregates mixed verdicts and prints every section", () => {
		const mixedPlan = plan({
			expectations: [
				{
					id: "E1",
					statement: "The request is visible",
					source: "ticket",
					priority: "high",
				},
				{
					id: "E2",
					statement: "The request can be approved",
					source: "ticket",
					priority: "medium",
				},
				{
					id: "E3",
					statement: "The audit entry is written",
					source: "wiki",
					priority: "low",
				},
			],
		});
		const rendered = effectRunnerTest.renderStageReport(
			"grid-int",
			"GRID-42",
			{
				environment: "integration",
				system: "grid-allocation",
				access: "writable",
			},
			stageTestPlan.parse(mixedPlan),
			stageTestReport.parse(
				report({
					expectations: [
						{
							id: "E1",
							verdict: "fail",
							severity: "major",
							expected: "The request is visible",
							observed: "The page was empty",
							stepIds: ["1"],
							evidenceIds: ["ev-1"],
						},
						{
							id: "E2",
							verdict: "blocked",
							expected: "The request can be approved",
							observed: "The approver role was missing",
							stepIds: ["1"],
							evidenceIds: ["ev-1"],
						},
						{
							id: "E3",
							verdict: "inconclusive",
							expected: "The audit entry is written",
							observed: "The audit view was not reachable",
							stepIds: ["1"],
							evidenceIds: ["ev-1"],
						},
					],
					createdData: [
						{
							description: "one grid connection request",
							cleanupHint: "request GRID-9001",
						},
					],
					knowledgeObservations: [
						{
							concept: "grid-connection-request",
							kind: "missing",
							statement: "Approvals need the approver role",
						},
					],
					notTested: [
						{
							expectationId: "E3",
							reason: "the audit view is unavailable in this stage",
						},
					],
				}),
			),
			[
				{
					seq: 1,
					at: "2026-04-01T12:00:00Z",
					app: "web",
					role: "clerk",
					label: "open the request",
				},
			],
			[
				{
					id: "ev-1",
					kind: "screenshot",
					file: "ev-1.png",
					caption: "Empty request page",
					createdAt: "2026-04-01T12:00:00Z",
				},
			],
			"2026-04-01T12:01:00Z",
		);
		expect(rendered).toContain("**Overall:** FAIL");
		expect(rendered).toContain(
			"- **FAIL / major — E1:** expected The request is visible; observed The page was empty. Steps: 1. Evidence: ev-1: Empty request page.",
		);
		expect(rendered).toContain(
			"- one grid connection request; cleanup: request GRID-9001",
		);
		expect(rendered).toContain(
			"- **missing: grid-connection-request** — Approvals need the approver role",
		);
		expect(rendered).toContain(
			"- E3: the audit view is unavailable in this stage",
		);
	});
	test("the stage-test tier pins its definition and step digests", () => {
		const definition = registerBuiltins().definition("stage-test", 1020);
		expect(definition.digest).toBe(
			"f10313bb6d2f189f8486b1b2873f6af8014c7443703ea55784ccfe9f106820a1",
		);
		expect(definition.stepDigests).toMatchObject({
			"stage.plan":
				"a4cf2de3c20404e6fa9290ebf4c91782d3599e60864b4109f6dc28d522d125eb",
			"stage.plan-review":
				"c461a811862104b5f1f60d67dabb72e1fea850106542a570ca9c857eb0dfb1eb",
			"stage.execute":
				"26d70acc3466d27559a2b94d4a30e6f5aac1321d7f1f782f6f7092de7d3a60b0",
			"stage.review":
				"8e56aae13d9d4250ba5dd97ac0043e3de0e9232885c525347c58c0a119774a64",
		});
	});
});

describe("stage-test handoff and render wiring", () => {
	test("the handoff refuses a report citing evidence that is not attached", () => {
		expect(() =>
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: plan() }),
				report({
					expectations: [
						{
							id: "E1",
							verdict: "blocked",
							expected: "The request is visible",
							observed: "The request could not be reached",
							stepIds: [],
							evidenceIds: ["ev-missing"],
						},
					],
				}),
				{
					stageJournal: [{ seq: 1 }],
					stageApps: ["web"],
					stageEvidenceIds: [],
				},
			),
		).toThrow(/evidence that is not attached/);
	});

	test("the plan gate owns both edges and its two developer actions", () => {
		const manifest = stageTestManifests(1020)[0];
		if (!manifest?.allowedOutcomes)
			throw new Error("missing stage-test manifest");
		expect(manifest.allowedOutcomes["stage.plan-review"]).toEqual([
			"approve",
			"comments",
		]);
		expect(
			manifest.edges
				.filter(({ from }) => from === "stage.plan-review")
				.map(({ outcome, to, loop }) => ({
					outcome,
					to,
					maxAttempts: loop?.maxAttempts,
				})),
		).toEqual([
			{ outcome: "approve", to: "stage.execute", maxAttempts: undefined },
			{ outcome: "comments", to: "stage.plan", maxAttempts: 3 },
		]);
		expect(
			manifest.edges
				.filter(({ from }) => from === "stage.plan")
				.map(({ outcome, loop }) => ({
					outcome,
					maxAttempts: loop?.maxAttempts,
				})),
		).toEqual([
			{ outcome: "needs-approval", maxAttempts: undefined },
			{ outcome: "execute", maxAttempts: undefined },
			{ outcome: "blocked", maxAttempts: 3 },
			{ outcome: "failed", maxAttempts: 3 },
		]);
		const actions =
			stageTestBehaviors["stage.plan-review"]?.developerActions?.({
				snapshot: snapshot({}),
			}) ?? [];
		expect(actions.map(({ id }) => id)).toEqual([
			"approve-plan",
			"review-comments",
		]);
	});

	test("the render effect attaches the rendered report flagged as the run's report", async () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-render-"));
		const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "stage-render-wt-"));
		const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
		try {
			process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
			fs.mkdirSync(stagePaths(configDir).defsDir, { recursive: true });
			fs.writeFileSync(
				path.join(stagePaths(configDir).defsDir, "grid-int.json"),
				JSON.stringify({
					ident: "grid-int",
					displayName: "Grid integration",
					environment: "integration",
					system: "grid-allocation",
					access: "read-only",
					apps: {
						web: {
							label: "Grid web",
							url: "https://grid.example.test/",
							kind: "ui",
						},
					},
				}),
			);
			const current = {
				...snapshot({ worktree, stage: "grid-int", ticket: "GRID-42" }),
				workflowId: "stage-render-flag",
				status: "running",
				currentStep: "stage.execute",
				step: { attempt: 1, activeRunIds: [] },
			} as unknown as WorkflowSnapshot;
			const engine = {
				getSnapshot: () => current,
				effectIsLive: () => true,
			} as unknown as import("../src/workflow/runtime.ts").WorkflowEngine;
			const handler = agentEffectHandlers(stageTestWorkflowTarget(), engine, {
				registry: registerBuiltins(),
				adapters: new Map(),
			})["stage.report.render"];
			if (!handler) throw new Error("stage.report.render handler is missing");
			await Effect.runPromise(
				handler.execute({
					id: "render-effect",
					workflowId: "stage-render-flag",
					kind: "stage.report.render",
					payload: {
						plan: plan() as unknown as JsonValue,
						report: report({
							expectations: [
								{
									id: "E1",
									verdict: "blocked",
									expected: "The request is visible",
									observed: "The page did not load",
									stepIds: [],
									evidenceIds: [],
								},
							],
						}) as unknown as JsonValue,
					},
					lease: "lease",
				} as never),
			);
			const entries = listEvidence(
				workflowEvidenceScope({
					workflowId: "stage-render-flag",
					worktree,
					definitionId: "stage-test",
				}),
			).entries;
			const reports = entries.filter((entry) => entry.report === true);
			expect(reports).toHaveLength(1);
			expect(reports[0]?.kind).toBe("other");
			expect(reports[0]?.file).toMatch(/\.md$/);
		} finally {
			if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
			fs.rmSync(configDir, { recursive: true, force: true });
			fs.rmSync(worktree, { recursive: true, force: true });
		}
	});

	test("workspace setup uses the engine data root: a stage test has no branch or repository checkout", async () => {
		const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "stage-setup-wt-"));
		try {
			const current = {
				...snapshot({ worktree, stage: "grid-int", ticket: "GRID-42" }),
				workflowId: "stage-setup",
				status: "running",
			} as unknown as WorkflowSnapshot;
			const engine = {
				getSnapshot: () => current,
			} as unknown as import("../src/workflow/runtime.ts").WorkflowEngine;
			const handler = agentEffectHandlers(stageTestWorkflowTarget(), engine, {
				registry: registerBuiltins(),
				adapters: new Map(),
			})["workspace.setup"];
			if (!handler) throw new Error("workspace.setup handler is missing");
			const effect = {
				id: "setup-effect",
				workflowId: "stage-setup",
				kind: "workspace.setup",
				payload: { mode: "worktree" },
				lease: "lease",
			} as never;
			await expect(Effect.runPromise(handler.execute(effect))).resolves.toEqual(
				{ worktree, branch: "" },
			);
			await expect(Effect.runPromise(handler.observe(effect))).resolves.toEqual(
				{ worktree, branch: "" },
			);
		} finally {
			fs.rmSync(worktree, { recursive: true, force: true });
		}
	});

	test("arriving at a stage step selects its role, which the stage tools authorise by", () => {
		expect(
			stageTestBehaviors["stage.plan"]?.onArrive?.({} as never)?.selectedRoles,
		).toEqual(["stage-planner"]);
		expect(
			stageTestBehaviors["stage.execute"]?.onArrive?.({} as never)
				?.selectedRoles,
		).toEqual(["stage-tester"]);
	});

	test("a stage-test run's CLI resolves the engine target, not the working directory", () => {
		const previous = process.env.HERDR_WORKFLOW_TARGET;
		try {
			process.env.HERDR_WORKFLOW_TARGET = stageTestWorkflowTarget();
			expect(managedWorkflowTarget("/not/a/repository")).toBe(
				stageTestWorkflowTarget(),
			);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_TARGET;
			else process.env.HERDR_WORKFLOW_TARGET = previous;
		}
	});

	test("the render effect refuses a report carrying a configured secret", async () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-render-"));
		const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "stage-render-wt-"));
		const secret = "render-secret-sentinel";
		const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
		try {
			process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
			fs.writeFileSync(path.join(configDir, ".env"), `GRID_TOKEN=${secret}\n`);
			fs.mkdirSync(stagePaths(configDir).defsDir, { recursive: true });
			fs.writeFileSync(
				path.join(stagePaths(configDir).defsDir, "grid-int.json"),
				JSON.stringify({
					ident: "grid-int",
					displayName: "Grid integration",
					environment: "integration",
					system: "grid-allocation",
					access: "read-only",
					apps: {
						web: {
							label: "Grid web",
							url: "https://grid.example.test/",
							kind: "ui",
						},
					},
				}),
			);
			const current = {
				...snapshot({ worktree, stage: "grid-int", ticket: "GRID-42" }),
				workflowId: "stage-render",
				status: "running",
				currentStep: "stage.execute",
				step: { attempt: 1, activeRunIds: [] },
			} as unknown as WorkflowSnapshot;
			// The handler only reads the snapshot before its first refusal; the
			// secret check throws before the lease or evidence write is touched.
			const engine = {
				getSnapshot: () => current,
				effectIsLive: () => true,
			} as unknown as import("../src/workflow/runtime.ts").WorkflowEngine;
			const handler = agentEffectHandlers(stageTestWorkflowTarget(), engine, {
				registry: registerBuiltins(),
				adapters: new Map(),
			})["stage.report.render"];
			if (!handler) throw new Error("stage.report.render handler is missing");
			const rendered = report({
				expectations: [
					{
						id: "E1",
						verdict: "blocked",
						expected: "The request is visible",
						observed: `Login failed with ${secret}`,
						stepIds: [],
						evidenceIds: [],
					},
				],
			});
			await expect(
				Effect.runPromise(
					handler.execute({
						id: "render-effect",
						workflowId: "stage-render",
						kind: "stage.report.render",
						payload: {
							plan: plan() as unknown as JsonValue,
							report: rendered as unknown as JsonValue,
						},
						lease: "lease",
					} as never),
				),
			).rejects.toThrow(/configured secret/);
			expect(
				fs.existsSync(
					path.join(
						workflowEvidenceRoot({
							workflowId: "stage-render",
							worktree,
							definitionId: "stage-test",
						}),
						"stage-report.md",
					),
				),
			).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
			fs.rmSync(configDir, { recursive: true, force: true });
			fs.rmSync(worktree, { recursive: true, force: true });
		}
	});
});
