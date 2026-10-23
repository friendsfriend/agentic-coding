// Stage-replay eligibility at the impure boundary (`add-stage-flow-replay`):
// `workflow/runtime/stage-replay-eligibility.ts` computes the boolean the pure
// `stage.plan-review` developer action consumes. Exercised end to end: a flow
// is generated from one approved stage plan, and the same plan (and its
// perturbations) are then handed to the engine-side eligibility check.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import { STAGE_FLOW_DIRECTORY } from "../src/stage-blocks/flow.ts";
import { generateFlow } from "../src/stage-blocks/flow-generator.ts";
import {
	blockPlanFromRoute,
	validateStageBlockPlan,
} from "../src/stage-blocks/plan.ts";
import { stageBlockRegistry } from "../src/stage-blocks/registry.ts";
import { stageReplayEligible } from "../src/workflow/runtime/stage-replay-eligibility.ts";
import { flowSourceFromRoute } from "./support/flow-source-fixture.ts";

const ROOT = path.join(import.meta.dir, "..");
const FLOW_ID = "test-eligibility-customer-address";
const FLOW_DIR = path.join(ROOT, STAGE_FLOW_DIRECTORY, FLOW_ID);
const INPUTS = {
	path: "/customers/C-1001",
	customerId: "C-1001",
	street: "Teststr. 1",
	city: "Berlin",
	postalCode: "10115",
};

afterAll(() => {
	fs.rmSync(FLOW_DIR, { recursive: true, force: true });
});

const PLAN = {
	ticketSummary: "Fill the customer address",
	knowledgeStatus: "none" as const,
	flowId: FLOW_ID,
	inputs: INPUTS,
	expectations: [
		{
			id: "E1",
			statement: "The clerk is signed in",
			source: "ticket" as const,
			priority: "critical" as const,
		},
		{
			id: "E2",
			statement: "The customer address survives a reload",
			source: "ticket" as const,
			priority: "high" as const,
		},
	],
	knowledgeUsed: [],
	route: [
		{
			id: "login",
			application: "crm",
			role: "clerk",
			action: "sign in",
			expected: "signed in",
			capture: [],
			expectationIds: ["E1"],
			block: { id: "crm.auth.loginAsRole", args: { role: "clerk" } },
		},
		{
			id: "open",
			application: "crm",
			role: "clerk",
			action: "open the customer",
			expected: "detail visible",
			capture: [],
			expectationIds: ["E2"],
			block: {
				id: "crm.ui.open",
				args: { path: "{{ inputs.path }}", readyTestId: "customer-detail" },
			},
		},
		{
			id: "customer",
			application: "crm",
			role: "clerk",
			action: "open the customer",
			expected: "detail visible",
			capture: [],
			expectationIds: ["E2"],
			block: {
				id: "crm.customer.open",
				args: { customerId: "{{ inputs.customerId }}" },
			},
		},
		{
			id: "address",
			application: "crm",
			role: "clerk",
			action: "fill and save",
			expected: "address saved",
			capture: [],
			expectationIds: ["E2"],
			block: {
				id: "crm.customer.fillAddress",
				args: {
					customerId: "{{ inputs.customerId }}",
					street: "{{ inputs.street }}",
					city: "{{ inputs.city }}",
					postalCode: "{{ inputs.postalCode }}",
					country: "DE",
				},
			},
		},
	],
	asyncWaits: [],
	createsData: true,
	dataCreated: ["a customer address"],
	notTested: [],
};

function snapshot(overrides: Record<string, unknown> = {}): WorkflowSnapshot {
	return {
		workflowId: "stage-eligibility",
		revision: 1,
		definition: { id: "stage-test", version: 1, digest: "pin", label: "" },
		metadata: {
			stage: "crm-int",
			worktree: ROOT,
			stageAccess: "writable",
			stageTestPlan: PLAN,
			...overrides,
		},
		evidence: [],
	} as unknown as WorkflowSnapshot;
}

async function saveFlow(): Promise<void> {
	const projected = blockPlanFromRoute(
		PLAN.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
		{
			planId: "stage-eligibility-r1",
			flowId: FLOW_ID,
			revision: 1,
			inputs: INPUTS,
		},
	);
	const validated = validateStageBlockPlan(projected.plan, {
		registry: stageBlockRegistry,
		policy: {
			stage: "crm-int",
			access: "writable",
			writeAllowed: true,
			apps: { crm: { roles: ["clerk"] } },
		},
	});
	if (validated.plan === undefined)
		throw new Error(JSON.stringify(validated.issues));
	const generated = await generateFlow({
		root: ROOT,
		registry: stageBlockRegistry,
		source: flowSourceFromRoute({
			routePlan: PLAN,
			plan: validated.plan,
			stage: "crm-int",
			planId: "stage-eligibility-r1",
			revision: 1,
		}),
	});
	if (generated.manifest === undefined)
		throw new Error(JSON.stringify(generated.issues));
}

describe("stage replay eligibility (add-stage-flow-replay)", () => {
	test("a saved flow is eligible from the plan that generated it", async () => {
		await saveFlow();
		expect(stageReplayEligible(snapshot())).toBe(true);
	});

	test("a plan with no flowId is ineligible", async () => {
		await saveFlow();
		expect(
			stageReplayEligible(
				snapshot({ stageTestPlan: { ...PLAN, flowId: undefined } }),
			),
		).toBe(false);
	});

	test("an unknown flowId is ineligible", async () => {
		await saveFlow();
		expect(
			stageReplayEligible(
				snapshot({ stageTestPlan: { ...PLAN, flowId: "no-such-flow" } }),
			),
		).toBe(false);
	});

	test("a saved flow no longer needs the plan's route to match", async () => {
		// A flow is data (`remove-stage-test-planner`): what it runs is its own
		// manifest, so an edited plan route cannot make it ineligible. Only the
		// plan's flowId and inputs still matter here, and they are unchanged.
		await saveFlow();
		expect(
			stageReplayEligible(
				snapshot({
					stageTestPlan: { ...PLAN, route: PLAN.route.slice(0, 2) },
				}),
			),
		).toBe(true);
	});

	test("no worktree is ineligible", async () => {
		await saveFlow();
		expect(stageReplayEligible(snapshot({ worktree: "" }))).toBe(false);
	});
});
