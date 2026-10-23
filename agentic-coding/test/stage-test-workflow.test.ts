import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { JsonValue, WorkflowSnapshot } from "../src/contracts/workflow.ts";
import { listEvidence } from "../src/server/evidence/store.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import type { StageDataBlockDocument } from "../src/stage-blocks/data-block.ts";
import {
	appendStageBlockProof,
	approvedBlockPath,
	readStageBlockDrafts,
	saveStageBlockDraft,
	storedDigest,
} from "../src/stage-blocks/data-store.ts";
import { managedWorkflowTarget } from "../src/workflow/cli/caller-environment.ts";
import { WorkflowRuntimeError } from "../src/workflow/contracts.ts";
import {
	stageTestPlan,
	stageTestReport,
} from "../src/workflow/definitions/contracts.ts";
import { stageTestManifests } from "../src/workflow/definitions/graphs/stage-test.ts";
import {
	definitionVersionForStageBlocks,
	definitionVersionForStageTest,
} from "../src/workflow/definitions/manifest-policy.ts";
import { WORKFLOW_STEPS } from "../src/workflow/definitions/steps.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	effectRunnerTest,
} from "../src/workflow/effect-runner.ts";
import { AGENT_DEFINITIONS } from "../src/workflow/embedded.generated.ts";
import {
	workflowEvidenceRoot,
	workflowEvidenceScope,
} from "../src/workflow/runtime/evidence-store.ts";
import { stageTestWorkflowTarget } from "../src/workflow/runtime.ts";
import {
	stagePlanDecisionIssues,
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
			noBlockReason: "no data block covers the request page yet",
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
	blocksUsed: [],
	unblockedSteps: [
		{
			routeStepId: "R1",
			reason: "no data block covers the request page yet",
		},
	],
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
	stepId: "stage.plan" | "stage.execute" | "stage.replay",
	current: WorkflowSnapshot,
	output: unknown,
	stage: {
		stageJournal?: readonly {
			seq: number;
			knowledge?: { concept: string; kind: string };
		}[];
		stageApps?: readonly string[];
		stageEvidenceIds?: readonly string[];
		stageBlockDrafts?: readonly {
			id: string;
			version: string;
			digest: string;
			proofs: readonly {
				status: "passed" | "failed";
				version: string;
				digest: string;
			}[];
		}[];
		stageReplayEvidence?: {
			result?: {
				status?: unknown;
				flowId?: unknown;
				planId?: unknown;
				revision?: unknown;
				inputsHash?: unknown;
				routeHash?: unknown;
				steps?: readonly { block?: unknown; version?: unknown }[];
			};
			report?: unknown;
			heal?: unknown;
			resultEvidenceId?: string;
			reportEvidenceId?: string;
			healEvidenceId?: string;
			blockDigests?: Readonly<Record<string, string>>;
		};
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
			role:
				stepId === "stage.plan"
					? "stage-planner"
					: stepId === "stage.replay"
						? "stage-tester"
						: "stage-tester",
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
	test("recovery guidance allows different techniques, never broader effects", () => {
		const inputs = stageTestBehaviors["stage.execute"]?.assignmentInputs?.({
			snapshot: snapshot({ stageTestPlan: plan() }),
			run: {
				stepId: "stage.execute",
				role: "stage-tester",
				profile: { readOnly: false },
			},
		});
		const text = inputs?.introLines?.join("\n") ?? "";
		expect(text).toContain(
			"improvise interaction techniques and equivalent paths",
		);
		expect(text).toContain("Preserve explicit developer constraints");
		expect(text).toContain("Never issue an unplanned state-changing action");
		expect(text).toContain("rather than a blocked run outcome");
	});

	test("embedded planner and tester recovery instructions match their sources", () => {
		for (const asset of ["stage-test-plan.md", "stage-test-execute.md"]) {
			const source = fs.readFileSync(
				new URL(
					`../../agent-definitions/instructions/${asset}`,
					import.meta.url,
				),
				"utf8",
			);
			expect(AGENT_DEFINITIONS[`instructions/${asset}`]).toBe(source);
		}
		const planner = AGENT_DEFINITIONS["instructions/stage-test-plan.md"];
		const tester = AGENT_DEFINITIONS["instructions/stage-test-execute.md"];
		expect(planner).toContain(
			"Do not add abort-on-validation or stop-on-first-error rules",
		);
		expect(tester).toContain("try a materially different approach");
		expect(tester).toContain("Repair artifact/schema/guard errors");
		expect(tester).toContain("Do not bypass product validation");
		expect(tester).not.toContain("Retry a failed read or navigation once");
	});

	test("an inaccessible scenario still completes into a rendered report", () => {
		const result = completeAgentStep(
			"stage.execute",
			snapshot({ stageTestPlan: plan() }),
			report({
				expectations: [
					{
						id: "E1",
						verdict: "blocked",
						expected: "The request is visible",
						observed: "Service outage persists after bounded investigation",
						stepIds: [],
						evidenceIds: [],
					},
				],
			}),
		);
		expect(result?.deferTransition).toBe(true);
		expect(result?.effects?.map(({ kind }) => kind)).toEqual([
			"stage.report.render",
		]);
	});

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

	test("a plan step must name exactly one block decision", () => {
		const exploratory = plan({
			route: [
				{
					id: "R1",
					application: "web",
					action: "open the request",
					expected: "Request details are visible",
					capture: [],
				},
			],
		});
		expect(() =>
			completeAgentStep(
				"stage.plan",
				snapshot({ stageTestPlan: undefined }),
				exploratory,
			),
		).toThrow(/names no block/);
		expect(() =>
			completeAgentStep(
				"stage.plan",
				snapshot({ stageTestPlan: undefined }),
				plan({
					route: [
						{
							...((exploratory.route as Record<string, unknown>[])[0] ?? {}),
							block: { id: "crm.customer.readAddress" },
							noBlockReason: "and also no block",
						},
					],
				}),
			),
		).toThrow(/exactly one of block/);
		expect(
			completeAgentStep(
				"stage.plan",
				snapshot({ stageTestPlan: undefined }),
				plan(),
			)?.transition?.outcome,
		).toBe("execute");
	});

	test("a plan persisted before the block decision existed still decodes", () => {
		// `MIG-001`: a `metadata.stageTestPlan` snapshot written before
		// `author-stage-blocks-as-data` has exploratory route steps with none of
		// block/blockToCreate/blockToAdjust/noBlockReason. The decoder must accept
		// it so the run can finish as it was approved; only a *new* plan is held to
		// the decision rule.
		const legacy = plan({
			route: [
				{
					id: "R1",
					application: "web",
					action: "open the request",
					expected: "Request details are visible",
					capture: ["status"],
				},
			],
		});
		const decoded = stageTestPlan.parse(legacy as JsonValue);
		expect(decoded.route).toHaveLength(1);
		expect(stagePlanDecisionIssues(decoded)).toHaveLength(1);
		// The run itself still executes: the plan is what it always was.
		expect(
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: legacy as JsonValue }),
				report(),
			),
		).toBeDefined();
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

	test("the report renderer shows the authored block and its adjustment", () => {
		const document = (overrides: Record<string, unknown> = {}) => ({
			format: 1,
			id: "grid.request.open",
			version: "1.0.0",
			app: "web",
			roles: ["clerk"],
			title: "Open one request",
			description: "Opens one request by reference.",
			effects: ["read"],
			idempotent: true,
			params: {
				type: "object",
				additionalProperties: false,
				properties: { reference: { type: "string" } },
				required: ["reference"],
			},
			returns: { type: "object", additionalProperties: false, properties: {} },
			examples: [{ reference: "REQ-1" }],
			postcondition: "the request details are visible",
			operations: [
				{
					op: "step",
					label: "open the request",
					operations: [
						{ op: "goto", path: "/requests/{{ args.reference }}" },
						{ op: "expectVisible", target: { testId: "request-detail" } },
					],
				},
			],
			...overrides,
		});
		const rendered = effectRunnerTest.renderStageReport(
			"grid-int",
			"GRID-42",
			{
				environment: "integration",
				system: "grid-allocation",
				access: "read-only",
			},
			stageTestPlan.parse(plan()),
			stageTestReport.parse(
				report({
					blocksUsed: [
						{
							routeStepId: "R1",
							block: "grid.request.open",
							version: "1.0.0",
						},
					],
					blocksCreated: [
						{
							routeStepId: "R1",
							block: "grid.request.open",
							version: "1.0.0",
							digest: "digest-1",
						},
					],
					blocksAdjusted: [
						{
							routeStepId: "R1",
							block: "grid.request.open",
							version: "1.1.0",
							digest: "digest-2",
						},
					],
					unblockedSteps: [],
				}),
			),
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
			{
				drafts: [
					{
						document: document() as never,
						proofs: [
							{
								status: "passed",
								journalIds: [12, 14],
								evidenceIds: ["ev-3"],
							},
						],
					},
					{
						document: document({
							version: "1.1.0",
							postcondition:
								"the request details and the audit entry are visible",
						}) as never,
						proofs: [
							{
								status: "passed",
								journalIds: [12, 14],
								evidenceIds: ["ev-3"],
							},
						],
					},
				],
				approved: [document() as never],
			},
		);
		expect(rendered).toContain("## Stage blocks");
		expect(rendered).toContain("grid.request.open@1.0.0");
		expect(rendered).toContain("grid.request.open@1.1.0");
		expect(rendered).toContain("created");
		expect(rendered).toContain("adjusted");
		expect(rendered).toContain("the request details are visible");
		// The proof line names what proved the block, so a reviewer can open it
		// instead of trusting the claim (`USAB-007`).
		expect(rendered).toContain(
			"- proof: passed (route step R1) — journal 12, 14; evidence ev-3",
		);
		// The section comes before the created data, and a report that claims no
		// block renders no section at all.
		expect(rendered.indexOf("## Stage blocks")).toBeLessThan(
			rendered.indexOf("## Created data"),
		);
		const plain = effectRunnerTest.renderStageReport(
			"grid-int",
			"GRID-42",
			{
				environment: "integration",
				system: "grid-allocation",
				access: "read-only",
			},
			stageTestPlan.parse(plan()),
			stageTestReport.parse(report()),
			[],
			[],
			"2026-04-01T12:01:00Z",
		);
		expect(plain).not.toContain("## Stage blocks");
	});

	test("the report gate itself refuses the block accounting it delegates", () => {
		// The delegation from `validReport` to `stageReportBlockIssues` is what
		// makes the blocks-first contract true for the workflow, not just for the
		// helper: these cases drive the refusals through `onAgentComplete`
		// (`TQV-103`).
		const blockedPlan = plan({
			route: [
				{
					id: "R1",
					application: "web",
					action: "open the request",
					expected: "Request details are visible",
					capture: [],
					blockToCreate: {
						id: "web.request.open",
						intent: "open one request by its id",
					},
				},
			],
		});
		const stage = {
			stageJournal: [{ seq: 1 }],
			stageApps: ["web"],
			stageEvidenceIds: ["ev-1"],
		};
		// A blank reason does not account for the step.
		expect(() =>
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: plan() }),
				report({ unblockedSteps: [{ routeStepId: "R1", reason: "   " }] }),
				stage,
			),
		).toThrow(/unblocked without a reason/);
		// A created block with no passed proof of it in this run.
		expect(
			() =>
				completeAgentStep(
					"stage.execute",
					snapshot({ stageTestPlan: blockedPlan }),
					report({
						blocksUsed: [
							{
								routeStepId: "R1",
								block: "web.request.open",
								version: "1.0.0",
							},
						],
						blocksCreated: [
							{
								block: "web.request.open",
								version: "1.0.0",
								digest: "digest-1",
								routeStepId: "R1",
							},
						],
						unblockedSteps: [],
					}),
					{
						...stage,
						stageBlockDrafts: [
							{
								id: "web.request.open",
								version: "1.0.0",
								digest: "digest-1",
								proofs: [
									{ status: "failed", version: "1.0.0", digest: "digest-1" },
								],
							},
						],
					},
				),
			// The refusal names the document the run holds, the proofs it does hold
			// and the remedy (`USAB-122`).
		).toThrow(
			/without a passed proof of the document this run holds \(1\.0\.0, digest digest-1\); recorded proofs: failed@1\.0\.0\/digest-1 — run the current document once with stage_run/,
		);
		// A route step named in neither list is a gap.
		expect(() =>
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: blockedPlan }),
				report({ unblockedSteps: [] }),
				stage,
			),
		).toThrow(/does not account for route step R1/);
		// And the same report with a passed proof passes the gate: the guard is a
		// rule about the run, not a refusal of authored blocks.
		expect(() =>
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: blockedPlan }),
				report({
					blocksUsed: [
						{ routeStepId: "R1", block: "web.request.open", version: "1.0.0" },
					],
					blocksCreated: [
						{
							block: "web.request.open",
							version: "1.0.0",
							digest: "digest-1",
							routeStepId: "R1",
						},
					],
					unblockedSteps: [],
				}),
				{
					...stage,
					stageBlockDrafts: [
						{
							id: "web.request.open",
							version: "1.0.0",
							digest: "digest-1",
							proofs: [
								{ status: "passed", version: "1.0.0", digest: "digest-1" },
							],
						},
					],
				},
			),
		).not.toThrow();
		// A proof of a different body is not a proof of this one, so the claim is
		// refused even though a passing proof exists for the same version.
		expect(() =>
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: blockedPlan }),
				report({
					blocksUsed: [
						{ routeStepId: "R1", block: "web.request.open", version: "1.0.0" },
					],
					blocksCreated: [
						{
							block: "web.request.open",
							version: "1.0.0",
							digest: "digest-2",
							routeStepId: "R1",
						},
					],
					unblockedSteps: [],
				}),
				{
					...stage,
					stageBlockDrafts: [
						{
							id: "web.request.open",
							version: "1.0.0",
							digest: "digest-2",
							proofs: [
								{ status: "passed", version: "1.0.0", digest: "digest-1" },
							],
						},
					],
				},
			),
		).toThrow(
			/without a passed proof of the document this run holds \(1\.0\.0, digest digest-2\); recorded proofs: passed@1\.0\.0\/digest-1/,
		);
		// The claim itself names the document: a same-version re-save is a
		// different block, and a claim citing the digest the tester saw before the
		// re-save is refused even when a passed proof of the live body exists
		// (`SEC-005`, `CONC-105`).
		expect(() =>
			completeAgentStep(
				"stage.execute",
				snapshot({ stageTestPlan: blockedPlan }),
				report({
					blocksUsed: [
						{ routeStepId: "R1", block: "web.request.open", version: "1.0.0" },
					],
					blocksCreated: [
						{
							block: "web.request.open",
							version: "1.0.0",
							digest: "digest-1",
							routeStepId: "R1",
						},
					],
					unblockedSteps: [],
				}),
				{
					...stage,
					stageBlockDrafts: [
						{
							id: "web.request.open",
							version: "1.0.0",
							digest: "digest-2",
							proofs: [
								{ status: "passed", version: "1.0.0", digest: "digest-2" },
							],
						},
					],
				},
			),
		).toThrow(/with digest digest-1, but the draft the run holds is digest-2/);
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
		const definition = registerBuiltins().definition("stage-test", 1021);
		expect(definition.digest).toBe(
			"e59699b782a35caf02afcef2d1b02bd6719e296116156901f0e50e4edb6ad497",
		);
		expect(definition.stepDigests).toMatchObject({
			"stage.plan":
				"a4cf2de3c20404e6fa9290ebf4c91782d3599e60864b4109f6dc28d522d125eb",
			"stage.plan-review":
				"5df5d6f8cfcc6b5c36c6d63dec2ffef4b72b0cdbf410e99ae6de8bc3e6b3bbdb",
			"stage.execute":
				"26d70acc3466d27559a2b94d4a30e6f5aac1321d7f1f782f6f7092de7d3a60b0",
			"stage.replay":
				"83ee79a0e0036151d7f8a96ffa438004ce6edc2663b7220377e5039b35558af1",
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

	test("approving the report promotes the run's authored block drafts", () => {
		const withBlocks = stageTestManifests(1101, true)[0];
		if (!withBlocks) throw new Error("missing stage-test manifest");
		const reviewEdges = withBlocks.edges.filter(
			({ from }) => from === "stage.review",
		);
		for (const outcome of ["approve", "approve-and-update-wiki"] as const) {
			const edge = reviewEdges.find((entry) => entry.outcome === outcome);
			expect(edge?.effects?.map((effect) => effect.kind)).toEqual([
				"stage.blocks.promote",
			]);
			expect(edge?.effects?.[0]?.idempotencyKey).toBe("stage-blocks-promote");
		}
		// The pre-blocks tier keeps its exact graph: a pinned workflow never grows
		// an effect it did not approve.
		const plain = stageTestManifests(1001)[0];
		expect(
			plain?.edges.flatMap((edge) => edge.effects ?? []).map((e) => e.kind),
		).toEqual(["wiki.verify"]);
	});

	test("an authored-blocks definition version never collides with a plan-only one", () => {
		for (let round = 1; round <= 40; round += 1)
			expect(definitionVersionForStageBlocks(round)).not.toBe(
				definitionVersionForStageTest(round + 1),
			);
		expect(definitionVersionForStageBlocks(1)).toBe(1101);
	});

	test("the plan gate owns both edges and its two developer actions", () => {
		const manifest = stageTestManifests(1021)[0];
		if (!manifest?.allowedOutcomes)
			throw new Error("missing stage-test manifest");
		expect(manifest.allowedOutcomes["stage.plan-review"]).toEqual([
			"approve",
			"approve-and-replay",
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
			{
				outcome: "approve-and-replay",
				to: "stage.replay",
				maxAttempts: undefined,
			},
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

	function promoteStageFixture(options: {
		readonly access?: "read-only" | "writable";
	}) {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-promote-"));
		const worktree = fs.mkdtempSync(
			path.join(os.tmpdir(), "stage-promote-wt-"),
		);
		fs.mkdirSync(stagePaths(configDir).defsDir, { recursive: true });
		fs.writeFileSync(
			path.join(stagePaths(configDir).defsDir, "grid-int.json"),
			JSON.stringify({
				ident: "grid-int",
				displayName: "Grid integration",
				environment: "integration",
				system: "grid-allocation",
				access: options.access ?? "read-only",
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid.example.test/",
						kind: "ui",
						roles: { clerk: {} },
					},
				},
			}),
		);
		const workflowId = "stage-promote";
		const scope = workflowEvidenceScope({
			workflowId,
			worktree,
			definitionId: "stage-test",
		});
		return { configDir, worktree, workflowId, scope };
	}

	const stageBlockDocument = (
		overrides: Partial<StageDataBlockDocument> = {},
	): StageDataBlockDocument => ({
		format: 1,
		id: "grid.request.open",
		version: "1.0.0",
		app: "web",
		roles: ["clerk"],
		title: "Open one request",
		description: "Opens one request and reads its status.",
		effects: ["read"],
		idempotent: true,
		params: {
			type: "object",
			additionalProperties: false,
			properties: { requestId: { type: "string", minLength: 1 } },
			required: ["requestId"],
		},
		returns: {
			type: "object",
			additionalProperties: false,
			properties: { status: { type: "string" } },
			required: ["status"],
		},
		examples: [{ requestId: "R-1001" }],
		postcondition: "the request page shows its status",
		operations: [
			{
				op: "step",
				label: "open the request",
				expected: "the request page is visible",
				operations: [
					{ op: "goto", path: "/requests/{{ args.requestId }}" },
					{ op: "expectVisible", target: { role: "heading" } },
				],
			},
		],
		...overrides,
	});

	function promoteHandler(
		worktree: string,
		metadata: Record<string, unknown>,
		workflowId: string,
	) {
		const current = {
			...snapshot({ worktree, stage: "grid-int", ...metadata }),
			workflowId,
			status: "running",
			currentStep: "stage.review",
			step: { attempt: 1, activeRunIds: [] },
		} as unknown as WorkflowSnapshot;
		const engine = {
			getSnapshot: () => current,
			effectIsLive: () => true,
		} as unknown as import("../src/workflow/runtime.ts").WorkflowEngine;
		const handler = agentEffectHandlers(stageTestWorkflowTarget(), engine, {
			registry: registerBuiltins(),
			adapters: new Map(),
		})["stage.blocks.promote"];
		if (!handler) throw new Error("stage.blocks.promote handler is missing");
		return handler;
	}

	function promoteEffect(workflowId: string) {
		return {
			id: "promote-effect",
			workflowId,
			kind: "stage.blocks.promote",
			payload: {},
			lease: "lease",
		} as never;
	}

	test("the promote effect publishes only the claimed draft and drops the scratch one", async () => {
		const fixture = promoteStageFixture({});
		const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
		try {
			process.env.AGENTIC_CODING_CONFIG_DIR = fixture.configDir;
			const claimed = stageBlockDocument();
			const scratch = stageBlockDocument({ id: "grid.request.list" });
			for (const document of [claimed, scratch])
				saveStageBlockDraft({
					dataRoot: fixture.scope.dataRoot,
					workflowId: fixture.workflowId,
					stage: "grid-int",
					document,
				});
			appendStageBlockProof({
				dataRoot: fixture.scope.dataRoot,
				workflowId: fixture.workflowId,
				document: claimed,
				proof: {
					stage: "grid-int",
					runId: "run",
					status: "passed",
					at: new Date().toISOString(),
					journalIds: [1],
					evidenceIds: ["ev-1"],
				},
			});
			const handler = promoteHandler(
				fixture.worktree,
				{
					stageSystem: "grid-allocation",
					stageTestReport: report({
						blocksUsed: [
							{ routeStepId: "R1", block: claimed.id, version: "1.0.0" },
						],
						blocksCreated: [
							{
								block: claimed.id,
								version: "1.0.0",
								digest: storedDigest(claimed),
								routeStepId: "R1",
							},
						],
						unblockedSteps: [],
					}),
				},
				fixture.workflowId,
			);
			await expect(
				Effect.runPromise(handler.execute(promoteEffect(fixture.workflowId))),
			).resolves.toMatchObject({
				promoted: [`${claimed.id}@1.0.0`],
				claims: [
					{
						id: claimed.id,
						version: "1.0.0",
						digest: storedDigest(claimed),
					},
				],
			});
			// Published under the stage's system, with the document the run saved.
			expect(
				fs.existsSync(
					approvedBlockPath(fixture.configDir, "grid-allocation", claimed.id),
				),
			).toBe(true);
			// The unclaimed draft is scratch: it is neither published nor kept.
			expect(
				fs.existsSync(
					approvedBlockPath(fixture.configDir, "grid-allocation", scratch.id),
				),
			).toBe(false);
			expect(
				readStageBlockDrafts(fixture.scope.dataRoot, fixture.workflowId).drafts,
			).toEqual([]);
			// The approval's second half is the draft removal, and the effect is
			// recorded only after both. A re-run therefore finds the drafts gone and
			// the blocks published: it must report the recovery, not fail the
			// workflow on its own success (`CONC-101`).
			await expect(
				Effect.runPromise(handler.execute(promoteEffect(fixture.workflowId))),
			).resolves.toMatchObject({
				promoted: [`${claimed.id}@1.0.0`],
				recovered: true,
			});
			if (!handler.observe) throw new Error("promotion has no observe");
			await expect(
				Effect.runPromise(handler.observe(promoteEffect(fixture.workflowId))),
			).resolves.toMatchObject({ recovered: true });
		} finally {
			if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
			fs.rmSync(fixture.configDir, { recursive: true, force: true });
			fs.rmSync(fixture.worktree, { recursive: true, force: true });
		}
	});

	test("the promote effect re-applies the stage scope to a draft saved earlier", async () => {
		const fixture = promoteStageFixture({ access: "read-only" });
		const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
		try {
			process.env.AGENTIC_CODING_CONFIG_DIR = fixture.configDir;
			const document = stageBlockDocument({ effects: ["write"] });
			saveStageBlockDraft({
				dataRoot: fixture.scope.dataRoot,
				workflowId: fixture.workflowId,
				stage: "grid-int",
				document,
			});
			appendStageBlockProof({
				dataRoot: fixture.scope.dataRoot,
				workflowId: fixture.workflowId,
				document,
				proof: {
					stage: "grid-int",
					runId: "run",
					status: "passed",
					at: new Date().toISOString(),
					journalIds: [1],
					evidenceIds: ["ev-1"],
				},
			});
			const handler = promoteHandler(
				fixture.worktree,
				{
					stageTestReport: report({
						blocksUsed: [
							{ routeStepId: "R1", block: document.id, version: "1.0.0" },
						],
						blocksCreated: [
							{
								block: document.id,
								version: "1.0.0",
								digest: storedDigest(document),
								routeStepId: "R1",
							},
						],
						unblockedSteps: [],
					}),
				},
				fixture.workflowId,
			);
			await expect(
				Effect.runPromise(handler.execute(promoteEffect(fixture.workflowId))),
			).rejects.toThrow(/may not be published: stage grid-int is read-only/);
			expect(
				readStageBlockDrafts(fixture.scope.dataRoot, fixture.workflowId).drafts,
			).toHaveLength(1);
		} finally {
			if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
			fs.rmSync(fixture.configDir, { recursive: true, force: true });
			fs.rmSync(fixture.worktree, { recursive: true, force: true });
		}
	});

	test("an unclaimed draft cannot veto or join the approval", async () => {
		// The run may have saved a block the developer never saw — an abandoned
		// experiment, or one on an application the stage lost since. Publishing the
		// claimed documents must not re-decide that draft's scope in either
		// direction (`CONC-106`).
		const fixture = promoteStageFixture({ access: "read-only" });
		const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
		try {
			process.env.AGENTIC_CODING_CONFIG_DIR = fixture.configDir;
			const claimed = stageBlockDocument();
			const abandoned = stageBlockDocument({
				id: "grid.request.cancel",
				effects: ["write"],
			});
			for (const document of [claimed, abandoned])
				saveStageBlockDraft({
					dataRoot: fixture.scope.dataRoot,
					workflowId: fixture.workflowId,
					stage: "grid-int",
					document,
				});
			appendStageBlockProof({
				dataRoot: fixture.scope.dataRoot,
				workflowId: fixture.workflowId,
				document: claimed,
				proof: {
					stage: "grid-int",
					runId: "run",
					status: "passed",
					at: new Date().toISOString(),
					journalIds: [1],
					evidenceIds: ["ev-1"],
				},
			});
			const handler = promoteHandler(
				fixture.worktree,
				{
					stageSystem: "grid-allocation",
					stageTestReport: report({
						blocksUsed: [
							{ routeStepId: "R1", block: claimed.id, version: "1.0.0" },
						],
						blocksCreated: [
							{
								block: claimed.id,
								version: "1.0.0",
								digest: storedDigest(claimed),
								routeStepId: "R1",
							},
						],
						unblockedSteps: [],
					}),
				},
				fixture.workflowId,
			);
			await expect(
				Effect.runPromise(handler.execute(promoteEffect(fixture.workflowId))),
			).resolves.toMatchObject({ promoted: [`${claimed.id}@1.0.0`] });
			expect(
				fs.existsSync(
					approvedBlockPath(fixture.configDir, "grid-allocation", abandoned.id),
				),
			).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
			fs.rmSync(fixture.configDir, { recursive: true, force: true });
			fs.rmSync(fixture.worktree, { recursive: true, force: true });
		}
	});

	test("an adjustment at the same version is published, not reported as already promoted", async () => {
		// The recovery path answers "did this approval already land?" from the
		// store. Matching the version alone answers yes for an adjustment that kept
		// the version and changed the body — the reviewed document would then be
		// dropped while the workflow reported it promoted (`SEC-005`, `CONC-105`,
		// `QUALITY-002`).
		const fixture = promoteStageFixture({});
		const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
		try {
			process.env.AGENTIC_CODING_CONFIG_DIR = fixture.configDir;
			const original = stageBlockDocument();
			const adjusted = stageBlockDocument({
				title: "open one request and read its status",
			});
			const handlerFor = (document: StageDataBlockDocument) =>
				promoteHandler(
					fixture.worktree,
					{
						stageSystem: "grid-allocation",
						stageTestReport: report({
							blocksCreated: [
								{
									block: document.id,
									version: document.version,
									digest: storedDigest(document),
									routeStepId: "R1",
								},
							],
							unblockedSteps: [],
						}),
					},
					fixture.workflowId,
				);
			const save = (document: StageDataBlockDocument) => {
				saveStageBlockDraft({
					dataRoot: fixture.scope.dataRoot,
					workflowId: fixture.workflowId,
					stage: "grid-int",
					document,
				});
				appendStageBlockProof({
					dataRoot: fixture.scope.dataRoot,
					workflowId: fixture.workflowId,
					document,
					proof: {
						stage: "grid-int",
						runId: "run",
						status: "passed",
						at: new Date().toISOString(),
						journalIds: [1],
						evidenceIds: ["ev-1"],
					},
				});
			};
			// First run: the original document is published and the drafts removed.
			save(original);
			await expect(
				Effect.runPromise(
					handlerFor(original).execute(promoteEffect(fixture.workflowId)),
				),
			).resolves.toMatchObject({ promoted: [`${original.id}@1.0.0`] });
			// A later run adjusts the body without bumping the version. With its
			// draft still on disk the approval has not landed, so the effect must
			// execute rather than report a recovery.
			save(adjusted);
			const handler = handlerFor(adjusted);
			if (!handler.observe) throw new Error("promotion has no observe");
			await expect(
				Effect.runPromise(handler.observe(promoteEffect(fixture.workflowId))),
			).resolves.toBeUndefined();
			await expect(
				Effect.runPromise(handler.execute(promoteEffect(fixture.workflowId))),
			).resolves.toMatchObject({ promoted: [`${adjusted.id}@1.0.0`] });
			expect(
				JSON.parse(
					fs.readFileSync(
						approvedBlockPath(
							fixture.configDir,
							"grid-allocation",
							adjusted.id,
						),
						"utf8",
					),
				),
			).toMatchObject({ title: adjusted.title });
			// And once the drafts are gone, a stale claim of the *old* body is not a
			// recovery: the store holds a different document at that version.
			save(original);
			fs.rmSync(
				path.dirname(
					readStageBlockDrafts(fixture.scope.dataRoot, fixture.workflowId)
						.drafts[0]?.file ?? "",
				),
				{ recursive: true, force: true },
			);
			await expect(
				Effect.runPromise(
					handlerFor(original).observe?.(promoteEffect(fixture.workflowId)) ??
						Effect.succeed("missing"),
				),
			).resolves.toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
			fs.rmSync(fixture.configDir, { recursive: true, force: true });
			fs.rmSync(fixture.worktree, { recursive: true, force: true });
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
			if (!handler.observe)
				throw new Error("workspace.setup observer is missing");
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

describe("stage.replay (add-stage-flow-replay)", () => {
	test("the plan gate offers replay only when the engine supplied eligibility", () => {
		const ineligible =
			stageTestBehaviors["stage.plan-review"]?.developerActions?.({
				snapshot: snapshot({ stageTestPlan: plan({ flowId: "flow-1" }) }),
				stageReplayEligible: false,
			}) ?? [];
		expect(ineligible.map(({ id }) => id)).toEqual([
			"approve-plan",
			"review-comments",
		]);
		const eligible =
			stageTestBehaviors["stage.plan-review"]?.developerActions?.({
				snapshot: snapshot({ stageTestPlan: plan({ flowId: "flow-1" }) }),
				stageReplayEligible: true,
			}) ?? [];
		expect(eligible.map(({ id }) => id)).toEqual([
			"approve-and-replay",
			"review-comments",
		]);
	});

	test("a passing replay attaches the render effect and a replay summary", () => {
		const current = snapshot({
			stageTestPlan: plan({ flowId: "flow-1" }),
		});
		const result = completeAgentStep(
			"stage.replay",
			current,
			{},
			{
				stageJournal: [{ seq: 1 }],
				stageApps: ["web"],
				stageEvidenceIds: ["ev-1"],
				stageReplayEvidence: {
					result: {
						status: "passed",
						planId: "stage-flow-r1",
						revision: 1,
						inputsHash: "sha256:in",
						routeHash: "sha256:route",
						steps: [{ block: "crm.open-customer", version: "1.0.0" }],
					},
					report: report(),
					resultEvidenceId: "ev-result",
					reportEvidenceId: "ev-report",
					blockDigests: { "crm.open-customer": "sha256:digest" },
				},
			},
		) as {
			metadata?: { stageReplay?: Record<string, unknown> };
			deferTransition?: boolean;
			effects?: readonly { kind: string; payload: unknown }[];
		};
		expect(result.deferTransition).toBe(true);
		expect(result.effects?.[0]?.kind).toBe("stage.report.render");
		expect(
			(result.effects?.[0]?.payload as { step?: string } | undefined)?.step,
		).toBe("stage.replay");
		expect(result.metadata?.stageReplay).toMatchObject({
			status: "passed",
			flowId: "flow-1",
			planId: "stage-flow-r1",
			revision: 1,
			resultEvidenceId: "ev-result",
			reportEvidenceId: "ev-report",
			blockVersions: { "crm.open-customer": "1.0.0" },
			blockDigests: { "crm.open-customer": "sha256:digest" },
		});
	});

	test("a failed replay carries the heal packet and falls back to the normal tester", () => {
		const current = snapshot({ stageTestPlan: plan({ flowId: "flow-1" }) });
		const result = completeAgentStep(
			"stage.replay",
			current,
			{},
			{
				stageReplayEvidence: {
					result: { status: "failed" },
					heal: { retryable: true, evidenceId: "ev-heal" },
					healEvidenceId: "ev-heal",
				},
			},
		) as {
			metadata?: {
				stageReplay?: Record<string, unknown>;
				stageReplayHeal?: Record<string, unknown>;
			};
			transition?: { outcome: string };
		};
		expect(result.transition).toEqual({ outcome: "failed" });
		expect(result.metadata?.stageReplay).toMatchObject({ status: "failed" });
		expect(result.metadata?.stageReplayHeal).toMatchObject({
			retryable: true,
		});
	});

	test("no replay evidence falls back to the normal tester without a model-asserted status", () => {
		const current = snapshot({ stageTestPlan: plan({ flowId: "flow-1" }) });
		const result = completeAgentStep("stage.replay", current, {}, {}) as {
			metadata?: { stageReplay?: Record<string, unknown> };
			transition?: { outcome: string };
		};
		expect(result.transition).toEqual({ outcome: "fallback" });
		expect(result.metadata?.stageReplay?.status).toBe("ineligible");
	});

	test("a plan with no flowId falls back immediately", () => {
		const current = snapshot({ stageTestPlan: plan({}) });
		const result = completeAgentStep("stage.replay", current, {}) as {
			metadata?: { stageReplay?: Record<string, unknown> };
			transition?: { outcome: string };
		};
		expect(result.transition).toEqual({ outcome: "fallback" });
		expect(result.metadata?.stageReplay?.reason).toBe("the plan names no flow");
	});
});
