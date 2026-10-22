// Compiled flow generation and eligibility (`add-stage-flow-replay`).
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	buildFlowManifest,
	canonicalInputsHash,
	STAGE_FLOW_DIRECTORY,
} from "../src/stage-blocks/flow.ts";
import { generateFlow } from "../src/stage-blocks/flow-generator.ts";
import {
	flowEligibility,
	readFlowRegistry,
} from "../src/stage-blocks/flow-registry.ts";
import { flowSourceFromStagePlan } from "../src/stage-blocks/flow-source.ts";
import { buildHealPacket } from "../src/stage-blocks/heal.ts";
import {
	blockPlanFromRoute,
	type NormalizedStageBlockPlan,
	validateStageBlockPlan,
} from "../src/stage-blocks/plan.ts";
import { stageBlockRegistry } from "../src/stage-blocks/registry.ts";
import { mapReplayToReport } from "../src/stage-blocks/replay-report.ts";
import { canonicalHash } from "../src/stage-blocks/schema.ts";
import { stageReportBlockIssues } from "../src/workflow/steps/stage-test.ts";

const ROOT = path.join(import.meta.dir, "..");
const FLOW_ID = "test-customer-address";
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
	for (const flow of ["test-secret-flow", "test-mixed-flow"])
		fs.rmSync(path.join(ROOT, STAGE_FLOW_DIRECTORY, flow), {
			recursive: true,
			force: true,
		});
});

const stagePlan = {
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
				args: {
					path: "{{ inputs.path }}",
					readyTestId: "customer-detail",
				},
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
					customerId: "{{ steps.customer.outputs.customerId }}",
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

function normalized(): NormalizedStageBlockPlan {
	const projected = blockPlanFromRoute(
		stagePlan.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
		{
			planId: "stage-test-r3",
			flowId: FLOW_ID,
			revision: 3,
			inputs: INPUTS,
		},
	);
	const validated = validateStageBlockPlan(projected.plan, {
		registry: stageBlockRegistry,
		policy: {
			stage: "crm-int",
			access: "writable",
			writeAllowed: true,
			role: "clerk",
			apps: { crm: { roles: ["clerk"] } },
		},
	});
	if (validated.plan === undefined)
		throw new Error(JSON.stringify(validated.issues));
	return validated.plan;
}

function source(plan = normalized()) {
	return flowSourceFromStagePlan({
		stagePlan,
		plan,
		stage: "crm-int",
		planId: "stage-test-r3",
		revision: 3,
	});
}

describe("flow generation", () => {
	test("writes a readable parameterized spec and manifest", async () => {
		fs.rmSync(FLOW_DIR, { recursive: true, force: true });
		const generated = await generateFlow({
			root: ROOT,
			source: source(),
			registry: stageBlockRegistry,
			typeCheck: true,
		});
		expect(generated.issues).toEqual([]);
		expect(generated.spec).toContain(
			'import { test } from "../../src/stage-blocks/fixture.ts";',
		);
		expect(generated.spec).toContain('stage.run("login", loginAsRole');
		expect(generated.spec).toContain('stage.input<string>("customerId")');
		expect(generated.spec).toContain(
			'const r_customer = await stage.run("customer", openCustomer',
		);
		expect(generated.spec).toContain("customerId: r_customer.customerId");
		expect(generated.spec).not.toContain("C-1001");
		expect(generated.spec).not.toContain("Teststr. 1");
		const manifest = generated.manifest;
		if (manifest === undefined) throw new Error("no manifest");
		expect(manifest.routeSteps.map((step) => step.routeStepId)).toEqual([
			"login",
			"open",
			"customer",
			"address",
		]);
		expect(manifest.routeSteps[3]?.inputs).toEqual([
			"city",
			"postalCode",
			"street",
		]);
		expect(manifest.routeSteps[3]?.outputs).toEqual(["customer.customerId"]);
		expect(manifest.inputSchema).toMatchObject({
			type: "object",
			additionalProperties: false,
			required: ["city", "customerId", "path", "postalCode", "street"],
		});
		expect(manifest.inputExamples).toEqual([INPUTS]);
		expect(fs.existsSync(path.join(FLOW_DIR, "flow.spec.ts"))).toBe(true);
		expect(fs.existsSync(path.join(FLOW_DIR, "flow.json"))).toBe(true);
	});

	test("the same route with different inputs produces a byte-identical spec", async () => {
		const other = {
			...INPUTS,
			path: "/customers/C-2002",
			customerId: "C-2002",
			street: "Andere Str. 2",
		};
		const first = await generateFlow({
			root: ROOT,
			source: source(),
			registry: stageBlockRegistry,
			typeCheck: false,
		});
		const second = await generateFlow({
			root: ROOT,
			source: flowSourceFromStagePlan({
				stagePlan,
				plan: (() => {
					const projected = blockPlanFromRoute(
						stagePlan.route as unknown as Parameters<
							typeof blockPlanFromRoute
						>[0],
						{
							planId: "stage-test-r4",
							flowId: FLOW_ID,
							revision: 4,
							inputs: other,
						},
					);
					const validated = validateStageBlockPlan(projected.plan, {
						registry: stageBlockRegistry,
						policy: {
							stage: "crm-int",
							access: "writable",
							writeAllowed: true,
							role: "clerk",
							apps: { crm: { roles: ["clerk"] } },
						},
					});
					if (validated.plan === undefined)
						throw new Error(JSON.stringify(validated.issues));
					return validated.plan;
				})(),
				stage: "crm-int",
				planId: "stage-test-r4",
				revision: 4,
			}),
			registry: stageBlockRegistry,
			typeCheck: false,
		});
		expect(first.spec).toBe(second.spec);
		expect(first.specHash).toBe(second.specHash);
		expect(first.routeHash).toBe(second.routeHash);
		expect(canonicalInputsHash(other)).not.toBe(first.inputsHash);
	});

	test("refuses a route change under an existing flow id", async () => {
		await generateFlow({
			root: ROOT,
			source: source(),
			registry: stageBlockRegistry,
			typeCheck: false,
		});
		const changed = source();
		const changedSteps = changed.steps.map((step) =>
			step.id === "open"
				? {
						...step,
						args: { ...step.args, readyTestId: "other-marker" },
					}
				: step,
		);
		const generated = await generateFlow({
			root: ROOT,
			source: { ...changed, steps: changedSteps },
			registry: stageBlockRegistry,
			typeCheck: false,
		});
		expect(generated.issues.map((issue) => issue.code)).toContain(
			"flow-route-changed",
		);
	});

	test("refuses a secret literal and a mixed plan", async () => {
		const secret = await generateFlow({
			root: ROOT,
			source: {
				...source(),
				flowId: "test-secret-flow",
				inputs: { ...INPUTS, path: "/stage-pw-sentinel" },
			},
			registry: stageBlockRegistry,
			secretValues: ["stage-pw-sentinel"],
			typeCheck: false,
		});
		expect(secret.issues.map((issue) => issue.code)).toContain(
			"flow-secret-literal",
		);
		expect(() =>
			flowSourceFromStagePlan({
				stagePlan: {
					...stagePlan,
					route: stagePlan.route.map((entry, index) =>
						index === 1 ? { ...entry, block: undefined } : entry,
					),
				},
				plan: normalized(),
				stage: "crm-int",
				planId: "stage-test-r3",
			}),
		).toThrow("has no block");
	});

	test("derives one input schema across differently worded blocks", () => {
		// `customerId` is described differently by openCustomer and
		// fillCustomerAddress; documentation must not be a type conflict.
		const generatedSource = source();
		const contract = buildFlowManifest(
			generatedSource,
			stageBlockRegistry,
			canonicalHash("spec"),
		);
		expect(contract.manifest?.inputSchema).toMatchObject({
			properties: { customerId: { type: "string" } },
		});
		expect(contract.issues).toEqual([]);
	});

	test("refuses a plan whose generated spec does not type-check", async () => {
		// `extra` has a default, so the runtime schema does not require it; the
		// example value still makes TypeScript infer it as a required property of
		// `country` has a default, so the runtime schema does not require it; its
		// value is still present in `fillCustomerAddress`'s own example, so
		// TypeScript infers it as a required property of the block's `Args` type.
		// Omitting it from a plan is schema-valid and type-invalid — exactly the
		// gap only `tsc` catches, not the runtime plan validator.
		const typeCheckRoute = stagePlan.route.map((entry) =>
			entry.id === "address"
				? {
						...entry,
						block: {
							...entry.block,
							args: {
								customerId: "{{ steps.customer.outputs.customerId }}",
								street: "{{ inputs.street }}",
								city: "{{ inputs.city }}",
								postalCode: "{{ inputs.postalCode }}",
							},
						},
					}
				: entry,
		);
		const typeMismatchStagePlan = {
			...stagePlan,
			flowId: "test-typecheck-flow",
			route: typeCheckRoute,
		};
		const projected = blockPlanFromRoute(
			typeCheckRoute as unknown as Parameters<typeof blockPlanFromRoute>[0],
			{
				planId: "stage-typecheck-r1",
				flowId: "test-typecheck-flow",
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
				role: "clerk",
				apps: { crm: { roles: ["clerk"] } },
			},
		});
		if (validated.plan === undefined)
			throw new Error(JSON.stringify(validated.issues));
		const generated = await generateFlow({
			root: ROOT,
			source: flowSourceFromStagePlan({
				stagePlan: typeMismatchStagePlan,
				plan: validated.plan,
				stage: "crm-int",
				planId: "stage-typecheck-r1",
				revision: 1,
			}),
			registry: stageBlockRegistry,
		});
		expect(generated.manifest).toBeUndefined();
		expect(generated.issues.map((issue) => issue.code)).toContain(
			"flow-spec-typecheck",
		);
		fs.rmSync(path.join(ROOT, STAGE_FLOW_DIRECTORY, "test-typecheck-flow"), {
			recursive: true,
			force: true,
		});
	});
});

describe("flow eligibility", () => {
	test("accepts a matching flow and rejects spec or digest drift", async () => {
		fs.rmSync(FLOW_DIR, { recursive: true, force: true });
		const generated = await generateFlow({
			root: ROOT,
			source: source(),
			registry: stageBlockRegistry,
			typeCheck: false,
		});
		expect(generated.manifest).toBeDefined();
		const eligible = flowEligibility({
			flowId: FLOW_ID,
			root: ROOT,
			stage: "crm-int",
			source: source(),
			registry: stageBlockRegistry,
			apps: { crm: { roles: ["clerk"] } },
			role: "clerk",
		});
		expect(eligible.issues).toEqual([]);
		expect(eligible.eligible).toBe(true);

		fs.writeFileSync(path.join(FLOW_DIR, "flow.spec.ts"), "// edited\n");
		const edited = flowEligibility({
			flowId: FLOW_ID,
			root: ROOT,
			stage: "crm-int",
			source: source(),
			registry: stageBlockRegistry,
			apps: { crm: { roles: ["clerk"] } },
			role: "clerk",
		});
		expect(edited.issues.map((issue) => issue.code)).toContain(
			"flow-spec-drift",
		);
		await generateFlow({
			root: ROOT,
			source: source(),
			registry: stageBlockRegistry,
			typeCheck: false,
		});
		const manifestPath = path.join(FLOW_DIR, "flow.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			blockDigests: Record<string, string>;
		};
		manifest.blockDigests["crm.ui.open"] = "sha256:deadbeef";
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		const digest = flowEligibility({
			flowId: FLOW_ID,
			root: ROOT,
			stage: "crm-int",
			source: source(),
			registry: stageBlockRegistry,
			apps: { crm: { roles: ["clerk"] } },
			role: "clerk",
		});
		expect(digest.issues.map((issue) => issue.code)).toContain(
			"flow-block-digest",
		);
	});

	test("rejects a stage or role mismatch", async () => {
		await generateFlow({
			root: ROOT,
			source: source(),
			registry: stageBlockRegistry,
			typeCheck: false,
		});
		const stage = flowEligibility({
			flowId: FLOW_ID,
			root: ROOT,
			stage: "other-stage",
			source: source(),
			registry: stageBlockRegistry,
			apps: { crm: { roles: ["clerk"] } },
			role: "clerk",
		});
		expect(stage.issues.map((issue) => issue.code)).toContain(
			"flow-stage-mismatch",
		);
		const role = flowEligibility({
			flowId: FLOW_ID,
			root: ROOT,
			stage: "crm-int",
			source: source(),
			registry: stageBlockRegistry,
			apps: { crm: { roles: ["clerk"] } },
			role: "admin",
		});
		expect(role.issues.map((issue) => issue.code)).toContain(
			"flow-role-missing",
		);
		const registry = readFlowRegistry(ROOT);
		expect(
			registry.entries.some((entry) => entry.manifest.flowId === FLOW_ID),
		).toBe(true);
	});
});

describe("replay report and heal packet", () => {
	test("maps pass, fail, blocked and uncovered expectations", () => {
		const manifest = buildFlowManifest(
			source(),
			stageBlockRegistry,
			canonicalHash("spec"),
		).manifest;
		if (manifest === undefined) throw new Error("no manifest");
		const result = {
			version: 1 as const,
			flowId: FLOW_ID,
			routeHash: manifest.routeHash,
			inputsHash: canonicalInputsHash(INPUTS),
			status: "failed" as const,
			startedAt: new Date(0).toISOString(),
			durationMs: 10,
			steps: [
				{
					index: 0,
					routeStepId: "login",
					block: "crm.auth.loginAsRole",
					version: "1.0.0",
					status: "passed" as const,
					durationMs: 4,
				},
				{
					index: 1,
					routeStepId: "open",
					block: "crm.ui.open",
					version: "1.0.0",
					status: "failed" as const,
					durationMs: 3,
					error: "selector not found",
				},
				{
					index: 2,
					routeStepId: "customer",
					block: "crm.customer.open",
					version: "1.0.0",
					status: "skipped" as const,
					durationMs: 0,
				},
				{
					index: 3,
					routeStepId: "address",
					block: "crm.customer.fillAddress",
					version: "1.0.0",
					status: "skipped" as const,
					durationMs: 0,
				},
			],
		};
		const mapped = mapReplayToReport(manifest, result, stagePlan, [
			{ index: 0, journalIds: [1], evidenceIds: ["ev-1"] },
			{ index: 1, journalIds: [2], evidenceIds: ["ev-2"] },
			{ index: 2, journalIds: [], evidenceIds: [] },
			{ index: 3, journalIds: [], evidenceIds: [] },
		]);
		expect(mapped.complete).toBe(true);
		const verdicts = Object.fromEntries(
			mapped.report.expectations.map((expectation) => [
				expectation.id,
				expectation.verdict,
			]),
		);
		expect(verdicts).toEqual({ E1: "pass", E2: "fail" });
		expect(mapped.report.expectations[1]?.severity).toBe("major");
		expect(mapped.report.expectations[1]?.evidenceIds).toEqual(["ev-2"]);
		// The replay accounts for the blocks it ran, so the workflow's report gate
		// accepts a mapped report exactly like a tester's own (`USAB-001`).
		expect(mapped.report.blocksUsed.map((block) => block.routeStepId)).toEqual([
			"login",
			"open",
			"customer",
			"address",
		]);
		expect(mapped.report.unblockedSteps).toEqual([]);
		expect(
			stageReportBlockIssues({
				plan: stagePlan as unknown as Parameters<
					typeof stageReportBlockIssues
				>[0]["plan"],
				report: {
					...mapped.report,
					notTested: mapped.report.notTested.map((entry) => ({ ...entry })),
				} as unknown as Parameters<typeof stageReportBlockIssues>[0]["report"],
			}),
		).toEqual([]);
		const uncovered = mapReplayToReport(
			manifest,
			result,
			{
				...stagePlan,
				expectations: [
					...stagePlan.expectations.map(
						({ source: _source, ...entry }) => entry,
					),
					{
						id: "E3",
						statement: "Unmapped",
						priority: "low" as const,
					},
				],
			},
			[],
		);
		expect(uncovered.complete).toBe(false);
		expect(
			uncovered.report.expectations.find((entry) => entry.id === "E3")?.verdict,
		).toBe("inconclusive");
	});

	test("the block accounting names every gap in a report", () => {
		const plan = {
			route: [
				{
					id: "open",
					block: { id: "crm.ui.open", version: "1.0.0", args: {} },
				},
				{ id: "address", blockToCreate: { id: "crm.customer.readAddress" } },
				{ id: "manual", noBlockReason: "the confirmation is one-off" },
			],
		} as unknown as Parameters<typeof stageReportBlockIssues>[0]["plan"];
		const report = (overrides: Record<string, unknown>) =>
			({
				blocksUsed: [],
				blocksCreated: [],
				blocksAdjusted: [],
				unblockedSteps: [],
				...overrides,
			}) as unknown as Parameters<typeof stageReportBlockIssues>[0]["report"];
		// A step named in neither list, a blank reason and a block the plan does
		// not plan for it are three separate refusals.
		expect(
			stageReportBlockIssues({
				plan,
				report: report({
					blocksUsed: [
						{ routeStepId: "open", block: "crm.ui.open", version: "1.0.0" },
						{ routeStepId: "address", block: "crm.ui.other", version: "1.0.0" },
					],
					unblockedSteps: [{ routeStepId: "manual", reason: "   " }],
				}),
			}),
		).toEqual([
			"stage report claims block crm.ui.other on route step address, but the plan names crm.customer.readAddress",
			"stage report lists route step manual as unblocked without a reason; say why this step runs without a block",
		]);
		expect(
			stageReportBlockIssues({
				plan,
				report: report({
					blocksUsed: [
						{ routeStepId: "open", block: "crm.ui.open", version: "1.0.0" },
					],
				}),
			}),
		).toEqual([
			"stage report does not account for route step address; name it in blocksUsed or in unblockedSteps with a reason",
			"stage report does not account for route step manual; name it in blocksUsed or in unblockedSteps with a reason",
		]);
		// A claim the run cannot back is its own refusal.
		expect(
			stageReportBlockIssues({
				plan,
				report: report({
					blocksUsed: [
						{ routeStepId: "open", block: "crm.ui.open", version: "1.0.0" },
					],
					blocksCreated: [
						{
							routeStepId: "address",
							block: "crm.customer.readAddress",
							version: "1.0.0",
							digest: "digest-1",
						},
					],
					unblockedSteps: [{ routeStepId: "manual", reason: "one-off" }],
				}),
				stageBlockDrafts: [
					{
						id: "crm.customer.readAddress",
						version: "1.0.0",
						digest: "digest-1",
						proofs: [
							{ status: "failed", version: "1.0.0", digest: "digest-1" },
						],
					},
				],
			}),
		).toEqual([
			"stage report claims block crm.customer.readAddress as created without a passed proof of the document this run holds (1.0.0, digest digest-1); recorded proofs: failed@1.0.0/digest-1 — run the current document once with stage_run and cite the version and digest stage_block_save returned",
			// A created draft is not an executed step: the route step still has to
			// appear in blocksUsed once it ran.
			"stage report does not account for route step address; name it in blocksUsed or in unblockedSteps with a reason",
		]);
		// The remaining refusals, one per branch of the loop, so an inverted guard
		// in any of them is visible (`TQV-104`). Each message names the route step
		// and the block, so the string doubles as the rule.
		const draft = (id: string, version = "1.0.0") => ({
			id,
			version,
			digest: `digest-${id}`,
			proofs: [{ status: "passed" as const, version, digest: `digest-${id}` }],
		});
		const quiet = [{ routeStepId: "manual", reason: "one-off" }];
		// blocksUsed naming a route step the plan does not contain.
		expect(
			stageReportBlockIssues({
				plan,
				report: report({
					blocksUsed: [
						{ routeStepId: "open", block: "crm.ui.open", version: "1.0.0" },
						{ routeStepId: "ghost", block: "crm.ui.open", version: "1.0.0" },
					],
					unblockedSteps: [
						...quiet,
						{ routeStepId: "address", reason: "authored later" },
					],
				}),
			}),
		).toEqual([
			"stage report names block crm.ui.open for route step ghost, which the plan does not contain",
		]);
		// blocksUsed on a step the plan plans as exploratory.
		expect(
			stageReportBlockIssues({
				plan,
				report: report({
					blocksUsed: [
						{ routeStepId: "open", block: "crm.ui.open", version: "1.0.0" },
						{ routeStepId: "manual", block: "crm.ui.open", version: "1.0.0" },
					],
					unblockedSteps: [
						{ routeStepId: "address", reason: "authored later" },
					],
				}),
			}),
		).toEqual([
			"stage report claims block crm.ui.open on route step manual, which the plan plans as an exploratory step",
		]);
		// unblockedSteps naming a route step the plan does not contain.
		expect(
			stageReportBlockIssues({
				plan,
				report: report({
					blocksUsed: [
						{ routeStepId: "open", block: "crm.ui.open", version: "1.0.0" },
					],
					unblockedSteps: [
						...quiet,
						{ routeStepId: "address", reason: "authored later" },
						{ routeStepId: "ghost", reason: "no such step" },
					],
				}),
			}),
		).toEqual([
			"stage report lists route step ghost as unblocked, which the plan does not contain",
		]);
		// blocksAdjusted: no draft, a version that differs from the draft, and a
		// route step that names a different block.
		const adjusted = (overrides: Record<string, unknown> = {}) =>
			report({
				blocksUsed: [
					{ routeStepId: "open", block: "crm.ui.open", version: "1.0.0" },
					{ routeStepId: "address", block: "crm.customer.readAddress" },
				],
				blocksAdjusted: [
					{
						routeStepId: "address",
						block: "crm.customer.readAddress",
						version: "1.0.0",
						digest: "digest-crm.customer.readAddress",
						...overrides,
					},
				],
				unblockedSteps: quiet,
			});
		const adjustedPlan = {
			route: [
				{
					id: "open",
					block: { id: "crm.ui.open", version: "1.0.0", args: {} },
				},
				{
					id: "address",
					blockToAdjust: {
						id: "crm.customer.readAddress",
						version: "1.0.0",
						intent: "read the address",
					},
				},
				{ id: "manual", noBlockReason: "the confirmation is one-off" },
			],
		} as unknown as Parameters<typeof stageReportBlockIssues>[0]["plan"];
		expect(
			stageReportBlockIssues({ plan: adjustedPlan, report: adjusted() }),
		).toEqual([
			"stage report claims block crm.customer.readAddress as adjusted, but this run holds no draft of it",
		]);
		expect(
			stageReportBlockIssues({
				plan: adjustedPlan,
				report: adjusted(),
				stageBlockDrafts: [draft("crm.customer.readAddress", "2.0.0")],
			}),
		).toEqual([
			// The draft's own proof is a proof of 2.0.0, so only the claim's version
			// is wrong here — the two checks are independent.
			"stage report claims block crm.customer.readAddress@1.0.0 as adjusted, but the draft is 2.0.0",
		]);
		expect(
			stageReportBlockIssues({
				plan: adjustedPlan,
				report: adjusted({ block: "crm.ui.other" }),
				stageBlockDrafts: [draft("crm.customer.readAddress")],
			}),
		).toEqual([
			"stage report claims block crm.ui.other as adjusted, but this run holds no draft of it",
		]);
		// The adjusted claim's own route step must name it: the created branch and
		// the adjusted branch read different plan fields, so one cannot stand in
		// for the other.
		expect(
			stageReportBlockIssues({
				plan: {
					route: [
						{
							id: "address",
							blockToCreate: { id: "crm.customer.readAddress" },
						},
					],
				} as unknown as Parameters<typeof stageReportBlockIssues>[0]["plan"],
				report: report({
					blocksUsed: [
						{
							routeStepId: "address",
							block: "crm.customer.readAddress",
							version: "1.0.0",
						},
					],
					blocksAdjusted: [
						{
							routeStepId: "address",
							block: "crm.customer.readAddress",
							version: "1.0.0",
							digest: "digest-crm.customer.readAddress",
						},
					],
				}),
				stageBlockDrafts: [draft("crm.customer.readAddress")],
			}),
		).toEqual([
			"stage report claims block crm.customer.readAddress as adjusted on route step address, but the plan names no such block",
		]);
		// And a claim for a route step the plan does not contain.
		expect(
			stageReportBlockIssues({
				plan: adjustedPlan,
				report: adjusted({ routeStepId: "ghost" }),
				stageBlockDrafts: [draft("crm.customer.readAddress")],
			}),
		).toEqual([
			"stage report claims block crm.customer.readAddress for route step ghost, which the plan does not contain",
		]);
	});

	test("builds a redaction-ready heal packet for a failed write", () => {
		const manifest = buildFlowManifest(
			source(),
			stageBlockRegistry,
			canonicalHash("spec"),
		).manifest;
		if (manifest === undefined) throw new Error("no manifest");
		const result = {
			version: 1 as const,
			flowId: FLOW_ID,
			planId: "stage-test-r3",
			revision: 3,
			routeHash: manifest.routeHash,
			inputsHash: canonicalInputsHash(INPUTS),
			status: "failed" as const,
			startedAt: new Date(0).toISOString(),
			durationMs: 20,
			steps: [
				{
					index: 0,
					routeStepId: "login",
					block: "crm.auth.loginAsRole",
					version: "1.0.0",
					status: "passed" as const,
					durationMs: 5,
				},
				{
					index: 1,
					routeStepId: "address",
					block: "crm.customer.fillAddress",
					version: "1.0.0",
					status: "failed" as const,
					durationMs: 15,
					error: "save failed",
				},
			],
			events: [
				{
					index: 1,
					routeStepId: "address",
					block: "crm.customer.fillAddress",
					version: "1.0.0",
					subStep: "save the address",
					status: "failed" as const,
					durationMs: 15,
					observed: "save failed",
					error: "save failed",
				},
			],
		};
		const heal = buildHealPacket({
			manifest,
			result,
			registry: stageBlockRegistry,
			evidenceIds: ["ev-2"],
			journalIds: [2],
			scopedRegion: { routeStepId: "address" },
		});
		expect(heal).toMatchObject({
			flowId: FLOW_ID,
			routeStepId: "address",
			block: "crm.customer.fillAddress",
			subStep: "save the address",
			retryable: false,
			evidenceIds: ["ev-2"],
			journalIds: [2],
			lastPassingStep: "login",
		});
		expect(JSON.stringify(heal)).not.toContain("C-1001");
	});
});
