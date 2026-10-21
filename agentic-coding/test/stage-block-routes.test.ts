// The typed stage-block routes (`add-stage-flow-blocks`): catalog, dry run,
// one-call execution and the additive stage-plan projection.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeDriver } from "../src/server/browser/fake-driver.ts";
import { BrowserInstaller } from "../src/server/browser/install.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import {
	type BrowserRouteDeps,
	handleBrowserRoute,
} from "../src/server/browser/routes.ts";
import {
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_STAGE_BLOCKS_PATH,
	AGENT_BROWSER_STAGE_FLOWS_PATH,
	AGENT_BROWSER_STAGE_JOURNAL_PATH,
	AGENT_BROWSER_STAGE_REPLAY_PATH,
	AGENT_BROWSER_STAGE_RUN_PATH,
} from "../src/server/protocol.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { StageUsageRegistry } from "../src/server/stages/limits.ts";
import {
	buildFlowManifest,
	STAGE_FLOW_DIRECTORY,
} from "../src/stage-blocks/flow.ts";
import { generateFlow } from "../src/stage-blocks/flow-generator.ts";
import { flowSourceFromStagePlan } from "../src/stage-blocks/flow-source.ts";
import {
	blockPlanFromRoute,
	validateStageBlockPlan,
} from "../src/stage-blocks/plan.ts";
import { stageBlockRegistry } from "../src/stage-blocks/registry.ts";
import { canonicalHash } from "../src/stage-blocks/schema.ts";
import { DEFAULT_BROWSER_VIEWPORT } from "../src/workflow/effects.ts";
import { workflowEvidenceRoot } from "../src/workflow/runtime/evidence-store.ts";
import { installedChromium } from "./support/browser.ts";

const OWNER = "workflow:wf-stage";
const PACKAGE_ROOT = path.join(import.meta.dir, "..");
const APP_URL = "https://crm-stage.example.test/";

interface Harness {
	readonly deps: BrowserRouteDeps;
	readonly worktree: string;
}

function configRoot(appUrl = APP_URL): string {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-blocks-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, ".env"),
		"CRM_STAGE_SECRET=stage-pw-sentinel\n",
	);
	fs.writeFileSync(
		path.join(defsDir, "crm-int.json"),
		`${JSON.stringify(
			{
				ident: "crm-int",
				displayName: "CRM integration",
				environment: "integration",
				system: "crm",
				access: "read-only",
				apps: {
					crm: { label: "CRM", url: appUrl, kind: "ui", roles: { clerk: {} } },
				},
				limits: { maxSessions: 2, maxActionsPerMinute: 60 },
			},
			null,
			2,
		)}\n`,
	);
	return configDir;
}

function build(
	currentStep = "stage.execute",
	appUrl = APP_URL,
	options: {
		readonly selectedRoles?: readonly string[];
		readonly stageTestPlan?: unknown;
	} = {},
): Harness {
	const configDir = configRoot(appUrl);
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "stage-blocks-wt-"));
	// `stage-test` workflows are not repository-backed (`workflowDataRoot`), so
	// every harness in this file that uses the fixed "wf-stage" id shares one
	// evidence/journal root regardless of the test's own temp worktree. Start
	// each harness from a clean root so one test's journal never leaks into
	// another's assertions.
	fs.rmSync(
		workflowEvidenceRoot({
			workflowId: "wf-stage",
			definitionId: "stage-test",
		}),
		{ recursive: true, force: true },
	);
	const chrome = path.join(worktree, "fake-chrome");
	fs.writeFileSync(chrome, "#!/bin/sh\n");
	const installer = new BrowserInstaller({
		configDir: path.join(worktree, "config"),
		chromeCandidates: [chrome],
		display: () => true,
	});
	const pool = new BrowserPool({
		driver: createFakeDriver(),
		launch: (options) => installer.resolveLaunch(options),
		maxSessions: () => 2,
		idleTtlMs: () => 900_000,
	});
	let clock = 1_000_000;
	return {
		worktree,
		deps: {
			installer,
			pool,
			configDir,
			settings: () => ({
				maxSessions: 2,
				idleTtlMs: 900_000,
				viewport: DEFAULT_BROWSER_VIEWPORT,
			}),
			stages: new StageUsageRegistry({
				now: () => clock,
				stageSessions: (owner, stage) => pool.stageSessions(owner, stage),
			}),
			locate: (workflowId: string) =>
				workflowId === "wf-stage"
					? {
							workflowId,
							worktree,
							stage: "crm-int",
							definitionId: "stage-test",
							currentStep,
							selectedRoles: options.selectedRoles ?? ["stage-tester"],
							revision: 3,
							stageTestPlan: ("stageTestPlan" in options
								? options.stageTestPlan
								: stagePlan()) as
								| import("../src/contracts/workflow.ts").JsonValue
								| undefined,
						}
					: undefined,
			now: () => (clock += 1_000),
		},
	};
}

async function call(
	deps: BrowserRouteDeps,
	routePath: string,
	body: unknown = {},
	owner = OWNER,
): Promise<{
	status: number;
	value: Record<string, unknown>;
	text: string;
}> {
	const url = `http://127.0.0.1:4050${routePath}`;
	const response = await handleBrowserRoute(
		deps,
		new Request(url, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
		new URL(url),
		owner,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const text = await response.text();
	const parsed = JSON.parse(text) as Record<string, unknown>;
	return {
		status: response.status,
		value:
			parsed.ok === true
				? (parsed.value as Record<string, unknown>)
				: ((parsed.error as Record<string, unknown>) ?? {}),
		text,
	};
}

async function openStage(deps: BrowserRouteDeps): Promise<void> {
	const opened = await call(deps, AGENT_BROWSER_OPEN_PATH, {
		stage: "crm-int",
		stageApp: "crm",
		stageRole: "clerk",
	});
	expect(opened.status).toBe(200);
}

const standaloneOpenPlan = (overrides: Record<string, unknown> = {}) => ({
	planId: "plan-customer",
	flowId: "customer-address",
	inputs: { path: "/customers/C-1001" },
	steps: [
		{
			id: "open",
			block: "crm.ui.open",
			args: { path: "{{ inputs.path }}", readyTestId: "customer-detail" },
		},
	],
	...overrides,
});

const stagePlan = (overrides: Record<string, unknown> = {}) => ({
	ticketSummary: "Open a customer",
	knowledgeStatus: "none",
	expectations: [
		{
			id: "E1",
			statement: "The customer is visible",
			source: "ticket",
			priority: "high",
		},
	],
	knowledgeUsed: [],
	flowId: "customer-address",
	inputs: { path: "/customers/C-2002" },
	route: [
		{
			id: "open",
			application: "crm",
			role: "clerk",
			action: "open the customer",
			expected: "The customer detail is visible",
			capture: [],
			expectationIds: ["E1"],
			block: {
				id: "crm.ui.open",
				args: { path: "{{ inputs.path }}", readyTestId: "customer-detail" },
			},
		},
	],
	asyncWaits: [],
	createsData: false,
	dataCreated: [],
	notTested: [],
	...overrides,
});

/** A temp workflow checkout needs the package's source and installed tools for
 * the generated-spec formatter/type-check; the fixtures themselves stay in the
 * temp directory. */
function linkPackage(worktree: string): void {
	for (const name of ["src", "node_modules", "package.json"]) {
		const target = path.join(PACKAGE_ROOT, name);
		const link = path.join(worktree, name);
		if (!fs.existsSync(link)) fs.symlinkSync(target, link);
	}
	// Keep the formatter self-contained: the repository config enables VCS ignore
	// discovery, which a bare temp checkout does not have.
	fs.writeFileSync(
		path.join(worktree, "biome.json"),
		JSON.stringify({
			formatter: { enabled: true, indentStyle: "tab" },
			linter: { enabled: false },
			vcs: { enabled: false },
		}),
	);
}

/** Generate a real spec/manifest pair for tests that execute the replay process. */
async function seedRealFlow(worktree: string): Promise<void> {
	const plan = stagePlan();
	const projected = blockPlanFromRoute(
		plan.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
		{
			planId: "stage-wf-stage-r3",
			flowId: "customer-address",
			revision: 3,
			inputs: plan.inputs as Record<
				string,
				import("../src/stage-blocks/schema.ts").JsonValue
			>,
		},
	);
	const validated = validateStageBlockPlan(projected.plan, {
		registry: stageBlockRegistry,
		policy: {
			stage: "crm-int",
			access: "read-only",
			writeAllowed: false,
			role: "clerk",
			apps: { crm: { roles: ["clerk"] } },
		},
	});
	if (validated.plan === undefined)
		throw new Error(JSON.stringify(validated.issues));
	const source = flowSourceFromStagePlan({
		stagePlan: plan,
		plan: validated.plan,
		stage: "crm-int",
		planId: "stage-wf-stage-r3",
		revision: 3,
	});
	const generated = await generateFlow({
		root: worktree,
		source,
		registry: stageBlockRegistry,
		typeCheck: false,
		format: false,
	});
	if (generated.manifest === undefined || generated.issues.length > 0)
		throw new Error(JSON.stringify(generated.issues));
}

/** Seed the same manifest/spec pair a green `stage_run save` would write, using
 * the one-route test plan. The spec content is opaque to the dry-run path; the
 * manifest hash is what eligibility checks. */
function seedFlow(worktree: string): void {
	const plan = stagePlan();
	const projected = blockPlanFromRoute(
		plan.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
		{
			planId: "stage-wf-stage-r3",
			flowId: "customer-address",
			revision: 3,
			inputs: plan.inputs as Record<
				string,
				import("../src/stage-blocks/schema.ts").JsonValue
			>,
		},
	);
	const validated = validateStageBlockPlan(projected.plan, {
		registry: stageBlockRegistry,
		policy: {
			stage: "crm-int",
			access: "read-only",
			writeAllowed: false,
			role: "clerk",
			apps: { crm: { roles: ["clerk"] } },
		},
	});
	if (validated.plan === undefined)
		throw new Error(JSON.stringify(validated.issues));
	const source = flowSourceFromStagePlan({
		stagePlan: plan,
		plan: validated.plan,
		stage: "crm-int",
		planId: "stage-wf-stage-r3",
		revision: 3,
	});
	const spec = "// seeded replay spec\n";
	const built = buildFlowManifest(
		source,
		stageBlockRegistry,
		canonicalHash(spec),
	);
	if (built.manifest === undefined)
		throw new Error(JSON.stringify(built.issues));
	const directory = path.join(
		worktree,
		STAGE_FLOW_DIRECTORY,
		"customer-address",
	);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "flow.spec.ts"), spec);
	fs.writeFileSync(
		path.join(directory, "flow.json"),
		`${JSON.stringify(built.manifest, null, 2)}\n`,
	);
}

describe("stage_blocks route", () => {
	test("serves the generated compact catalog and one full entry", async () => {
		const { deps } = build();
		const compact = await call(deps, AGENT_BROWSER_STAGE_BLOCKS_PATH, {});
		expect(compact.status).toBe(200);
		expect(compact.value.mode).toBe("compact");
		expect(compact.value.total).toBe(4);
		const first = (compact.value.blocks as Record<string, unknown>[])[0];
		expect(first?.id).toBe("crm.auth.loginAsRole");
		expect(first?.params).toBeUndefined();
		const full = await call(deps, AGENT_BROWSER_STAGE_BLOCKS_PATH, {
			id: "crm.ui.open",
		});
		expect(full.status).toBe(200);
		expect(full.value.mode).toBe("full");
		const entry = (full.value.blocks as Record<string, unknown>[])[0];
		expect(entry?.digest).toMatch(/^sha256:/);
		expect(entry?.params).toBeDefined();
		expect(entry?.contractTest).toBe("test/stage-blocks.test.ts");
		const unknown = await call(deps, AGENT_BROWSER_STAGE_BLOCKS_PATH, {
			id: "crm.nope",
		});
		expect(unknown.status).toBe(404);
		expect(unknown.value.code).toBe("block-unknown");
	});

	test("filters by app, effect and query", async () => {
		const { deps } = build();
		const reads = await call(deps, AGENT_BROWSER_STAGE_BLOCKS_PATH, {
			app: "crm",
			effect: "read",
			query: "customer",
		});
		expect(reads.status).toBe(200);
		expect(reads.value.total).toBe(1);
		expect(
			(reads.value.blocks as Record<string, unknown>[]).map(
				(entry) => entry.id,
			),
		).toEqual(["crm.customer.open"]);
	});
});

describe("stage_run route", () => {
	test("dry-runs a plan without a session and derives the input schema", async () => {
		const { deps } = build();
		const result = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: standaloneOpenPlan(),
			dryRun: true,
			stage: "crm-int",
		});
		expect(result.status).toBe(200);
		expect(result.value.status).toBe("passed");
		expect(result.value.planId).toBe("plan-customer");
		expect(result.value.steps).toEqual([]);
		expect(result.value.versions).toEqual({ "crm.ui.open": "1.0.0" });
		const dryRun = result.value.dryRun as Record<string, unknown>;
		expect(dryRun.ok).toBe(true);
		const schema = dryRun.inputSchema as Record<string, unknown>;
		expect(schema.required).toEqual(["path"]);
		expect(schema.properties).toMatchObject({
			path: { type: "string", minLength: 1, maxLength: 2048 },
		});
	});

	test("an invalid or secret-bearing plan is refused with stable issues", async () => {
		const { deps } = build();
		const invalid = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: {
				steps: [{ block: "crm.unknown", args: {} }],
			},
			dryRun: true,
		});
		expect(invalid.status).toBe(200);
		expect(invalid.value.status).toBe("failed");
		expect(
			(
				(invalid.value.dryRun as Record<string, unknown>).issues as Record<
					string,
					unknown
				>[]
			)[0]?.code,
		).toBe("block-unknown");
		const secret = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: standaloneOpenPlan({
				inputs: { path: "stage-pw-sentinel" },
			}),
			dryRun: true,
		});
		expect(secret.status).toBe(200);
		expect(secret.value.status).toBe("failed");
		expect(
			(
				(secret.value.dryRun as Record<string, unknown>).issues as Record<
					string,
					unknown
				>[]
			).some((issue) => issue.code === "plan-secret-literal"),
		).toBe(true);
	});

	test("runs one plan against a stage session and journals every sub-step", async () => {
		const { deps } = build();
		await openStage(deps);
		const result = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: standaloneOpenPlan(),
			session: "default",
		});
		expect(result.status).toBe(200);
		expect(result.value.status).toBe("passed");
		const steps = result.value.steps as Record<string, unknown>[];
		const first = steps[0];
		if (first === undefined) throw new Error("stage_run returned no steps");
		expect(first.status).toBe("passed");
		expect(first.block).toBe("crm.ui.open");
		expect(first.outputs).toMatchObject({
			url: `${APP_URL}customers/C-1001`,
		});
		expect((first.journalIds as number[]).length).toBe(1);
		const journal = await call(deps, AGENT_BROWSER_STAGE_JOURNAL_PATH, {
			session: "default",
		});
		expect(journal.status).toBe(200);
		const entries = journal.value.entries as Record<string, unknown>[];
		expect(entries.at(-1)).toMatchObject({
			block: "crm.ui.open",
			blockVersion: "1.0.0",
			planId: "plan-customer",
			routeStepId: "open",
			status: "passed",
			subStep: "open the application path",
		});
	});

	test("projects a stage-test plan and refuses a stale approved revision", async () => {
		const { deps } = build();
		await openStage(deps);
		const fresh = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: stagePlan(),
			session: "default",
			approvedRevision: 3,
			role: "clerk",
		});
		expect(fresh.status).toBe(200);
		expect(fresh.value.status).toBe("passed");
		expect(fresh.value.flowId).toBe("customer-address");
		expect(fresh.value.revision).toBe(3);
		const stale = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: stagePlan(),
			session: "default",
			approvedRevision: 2,
			role: "clerk",
		});
		expect(stale.status).toBe(409);
		expect(stale.value.code).toBe("stage-plan-stale");
	});

	test("executes a mixed plan's blocked step and reports the unblocked one as a plan-route-gap", async () => {
		const { deps } = build();
		await openStage(deps);
		const result = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: stagePlan({
				route: [
					...stagePlan().route,
					{
						id: "confirm",
						application: "crm",
						role: "clerk",
						action: "confirm the customer detail manually",
						expected: "the detail page still shows the customer",
						capture: [],
						expectationIds: ["E1"],
					},
				],
			}),
			session: "default",
			approvedRevision: 3,
			role: "clerk",
		});
		expect(result.status).toBe(200);
		const steps = result.value.steps as Record<string, unknown>[];
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ status: "passed", block: "crm.ui.open" });
		const issues = result.value.issues as Record<string, unknown>[];
		expect(issues).toEqual([
			expect.objectContaining({
				code: "plan-route-gap",
				routeStepId: "confirm",
			}),
		]);
	});

	test("saves a green parameterized flow into the workflow checkout", async () => {
		const { deps, worktree } = build();
		linkPackage(worktree);
		await openStage(deps);
		const result = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: stagePlan(),
			session: "default",
			save: true,
			approvedRevision: 3,
			role: "clerk",
		});
		expect(result.status).toBe(200);
		expect(result.value.status).toBe("passed");
		const saved = result.value.saved as Record<string, unknown>;
		expect(saved.flowId).toBe("customer-address");
		expect(saved.specPath).toBe("stage-flows/customer-address/flow.spec.ts");
		expect(saved.manifestPath).toBe("stage-flows/customer-address/flow.json");
		const specPath = path.join(worktree, saved.specPath as string);
		const manifestPath = path.join(worktree, saved.manifestPath as string);
		expect(fs.existsSync(specPath)).toBe(true);
		expect(fs.existsSync(manifestPath)).toBe(true);
		const spec = fs.readFileSync(specPath, "utf8");
		expect(spec).toContain('stage.run("open", openUiPath');
		expect(spec).toContain('stage.input<string>("path")');
		expect(spec).not.toContain("/customers/C-2002");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			routeHash: string;
			specHash: string;
			inputExamples: Record<string, unknown>[];
		};
		expect(manifest.routeHash).toBe(saved.routeHash as string);
		expect(manifest.specHash).toBe(saved.specHash as string);
		expect(manifest.inputExamples[0]).toEqual({ path: "/customers/C-2002" });
	});

	test("needs a stage-bound session for execution", async () => {
		const { deps } = build();
		const coreOwner = "workflow:wf-core";
		const opened = await call(
			deps,
			AGENT_BROWSER_OPEN_PATH,
			{ url: APP_URL },
			coreOwner,
		);
		expect(opened.status).toBe(200);
		const result = await call(
			deps,
			AGENT_BROWSER_STAGE_RUN_PATH,
			{
				plan: standaloneOpenPlan(),
				session: "default",
			},
			coreOwner,
		);
		expect(result.status).toBe(400);
		expect(result.value.code).toBe("stage-session-required");
	});
});

describe("stage_flows planner discovery (add-stage-flow-replay)", () => {
	test("the planner may list flows and the block catalog before any plan is approved, but no other stage tool", async () => {
		const { deps, worktree } = build("stage.plan", APP_URL, {
			selectedRoles: ["stage-planner"],
			stageTestPlan: undefined,
		});
		seedFlow(worktree);
		const flows = await call(deps, AGENT_BROWSER_STAGE_FLOWS_PATH, {});
		expect(flows.status).toBe(200);
		expect(
			(flows.value.flows as Record<string, unknown>[]).map(
				(entry) => entry.flowId,
			),
		).toEqual(["customer-address"]);
		const blocks = await call(deps, AGENT_BROWSER_STAGE_BLOCKS_PATH, {});
		expect(blocks.status).toBe(200);
		expect(Array.isArray(blocks.value.blocks)).toBe(true);
		const run = await call(deps, AGENT_BROWSER_STAGE_RUN_PATH, {
			plan: standaloneOpenPlan(),
			dryRun: true,
		});
		expect(run.status).toBe(403);
		expect(run.value.code).toBe("stage-test-tool-restricted");
		const replay = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			flowId: "customer-address",
			dryRun: true,
		});
		expect(replay.status).toBe(403);
		expect(replay.value.code).toBe("stage-test-tool-restricted");
		const open = await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "crm-int",
			stageApp: "crm",
			stageRole: "clerk",
		});
		expect(open.status).toBe(403);
		expect(open.value.code).toBe("stage-test-tool-restricted");
	});

	test("the tester cannot list flows outside execute or replay", async () => {
		const { deps, worktree } = build("stage.review");
		seedFlow(worktree);
		const flows = await call(deps, AGENT_BROWSER_STAGE_FLOWS_PATH, {});
		expect(flows.status).toBe(403);
		expect(flows.value.code).toBe("stage-test-tool-restricted");
	});

	test("planner discovery does not leak to a different step or role", async () => {
		const outsidePlan = build("stage.plan-review", APP_URL, {
			selectedRoles: ["stage-planner"],
			stageTestPlan: undefined,
		});
		const outside = await call(
			outsidePlan.deps,
			AGENT_BROWSER_STAGE_FLOWS_PATH,
			{},
		);
		expect(outside.status).toBe(403);
		expect(outside.value.code).toBe("stage-test-tool-restricted");
		const wrongRole = build("stage.plan", APP_URL, {
			selectedRoles: ["stage-tester"],
			stageTestPlan: undefined,
		});
		const notPlanner = await call(
			wrongRole.deps,
			AGENT_BROWSER_STAGE_BLOCKS_PATH,
			{},
		);
		expect(notPlanner.status).toBe(403);
		expect(notPlanner.value.code).toBe("stage-test-tool-restricted");
	});
});

describe("stage_replay route", () => {
	test("lists seeded flows and dry-runs an eligible approved input set", async () => {
		const { deps, worktree } = build("stage.replay");
		seedFlow(worktree);
		const list = await call(deps, AGENT_BROWSER_STAGE_FLOWS_PATH, {
			stage: "crm-int",
		});
		expect(list.status).toBe(200);
		expect(list.value.total).toBe(1);
		const flows = list.value.flows as Record<string, unknown>[];
		expect(flows[0]).toMatchObject({
			flowId: "customer-address",
			stage: "crm-int",
			applications: ["crm"],
			roles: ["clerk"],
		});
		const dry = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			flowId: "customer-address",
			dryRun: true,
		});
		expect(dry.status).toBe(200);
		expect(dry.value.status).toBe("passed");
		const dryRun = dry.value.dryRun as Record<string, unknown>;
		expect(dryRun.eligible).toBe(true);
		expect(dryRun.approved).toBe(true);
		expect((dryRun.issues as unknown[]).length).toBe(0);
		const schema = dryRun.inputSchema as Record<string, unknown>;
		expect(schema.required).toEqual(["path"]);
	});

	test("validates an unapproved input set without starting a browser", async () => {
		const { deps, worktree } = build("stage.replay");
		seedFlow(worktree);
		const dry = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			flowId: "customer-address",
			dryRun: true,
			inputs: { path: "/customers/C-9999" },
		});
		expect(dry.status).toBe(200);
		expect(dry.value.status).toBe("failed");
		const dryRun = dry.value.dryRun as Record<string, unknown>;
		expect(dryRun.eligible).toBe(true);
		expect(dryRun.approved).toBe(false);
		expect(
			(dryRun.issues as Record<string, unknown>[]).some(
				(issue) => issue.code === "flow-inputs-unapproved",
			),
		).toBe(true);
		const execute = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			flowId: "customer-address",
			inputs: { path: "/customers/C-9999" },
		});
		expect(execute.status).toBe(409);
		expect(execute.value.code).toBe("flow-inputs-unapproved");
	});

	test("refuses an unknown flow, a stale revision and a different stage", async () => {
		const { deps, worktree } = build("stage.replay");
		seedFlow(worktree);
		const mismatched = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			flowId: "not-saved",
			dryRun: true,
		});
		expect(mismatched.status).toBe(409);
		expect(mismatched.value.code).toBe("flow-id-mismatch");
		const missingHarness = build("stage.replay");
		const missing = await call(
			missingHarness.deps,
			AGENT_BROWSER_STAGE_REPLAY_PATH,
			{ flowId: "customer-address", dryRun: true },
		);
		expect(missing.status).toBe(409);
		expect(missing.value.code).toBe("flow-not-found");
		const stale = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			flowId: "customer-address",
			dryRun: true,
			approvedRevision: 2,
		});
		expect(stale.status).toBe(409);
		expect(stale.value.code).toBe("stage-plan-stale");
		const wrongStage = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			flowId: "customer-address",
			stage: "other-stage",
			dryRun: true,
		});
		expect(wrongStage.status).toBe(409);
		expect(wrongStage.value.code).toBe("stage-mismatch");
	});

	test("refuses a hand-edited spec and a route drift", async () => {
		const { deps, worktree } = build("stage.replay");
		seedFlow(worktree);
		fs.writeFileSync(
			path.join(
				worktree,
				STAGE_FLOW_DIRECTORY,
				"customer-address",
				"flow.spec.ts",
			),
			"// hand-edited\n",
		);
		const edited = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			flowId: "customer-address",
			dryRun: true,
		});
		expect(edited.status).toBe(200);
		const dryRun = edited.value.dryRun as Record<string, unknown>;
		expect(
			(dryRun.issues as Record<string, unknown>[]).some(
				(issue) => issue.code === "flow-spec-drift",
			),
		).toBe(true);
	});

	test("executes a saved flow and ingests its journal, report and result", async () => {
		let ready = true;
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (!ready || new URL(request.url).pathname !== "/customers/C-2002")
					return new Response("not found", { status: 404 });
				return new Response(
					'<!doctype html><html><body><h1 data-testid="customer-detail">Customer</h1></body></html>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		try {
			const { deps, worktree } = build(
				"stage.replay",
				`http://127.0.0.1:${server.port}/`,
			);
			linkPackage(worktree);
			await seedRealFlow(worktree);
			const chromium = installedChromium();
			if (chromium !== undefined && deps.installer !== undefined)
				Object.defineProperty(deps.installer, "installedChromium", {
					value: () => chromium,
				});
			const result = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
				flowId: "customer-address",
			});
			expect(result.status).toBe(200);
			expect(result.value.status).toBe("passed");
			expect(result.value.flowId).toBe("customer-address");
			expect(result.value.report).toBeDefined();
			expect(typeof result.value.reportEvidenceId).toBe("string");
			expect(typeof result.value.resultEvidenceId).toBe("string");
			const steps = result.value.steps as Record<string, unknown>[];
			expect(steps[0]?.routeStepId).toBe("open");
			const journalIds = steps[0]?.journalIds;
			expect(Array.isArray(journalIds)).toBe(true);
			expect((journalIds as number[]).length).toBe(1);
			const journal = await call(deps, AGENT_BROWSER_STAGE_JOURNAL_PATH, {});
			expect(journal.status).toBe(200);
			const entries = journal.value.entries as Record<string, unknown>[];
			expect(entries.at(-1)).toMatchObject({
				source: "replay",
				flowId: "customer-address",
				block: "crm.ui.open",
				subStep: "open the application path",
			});
			ready = false;
			const failed = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
				flowId: "customer-address",
			});
			expect(failed.status).toBe(200);
			expect(failed.value.status).toBe("failed");
			expect(failed.value.heal).toBeDefined();
			expect(failed.value.failure).toMatchObject({
				routeStepId: "open",
				block: "crm.ui.open",
			});
			const afterFailure = await call(
				deps,
				AGENT_BROWSER_STAGE_JOURNAL_PATH,
				{},
			);
			const failedEntries = afterFailure.value.entries as Record<
				string,
				unknown
			>[];
			expect(failedEntries.length).toBe(2);
			expect(failedEntries.at(-1)).toMatchObject({
				source: "replay",
				status: "failed",
			});
		} finally {
			server.stop(true);
		}
	}, 120_000);
});

describe("stage_replay suite route", () => {
	test("refuses a manifest with no entries and a parallel/shared-data conflict before starting any context", async () => {
		const { deps, worktree } = build("stage.replay");
		const suitePath = (suiteId: string) =>
			path.join(worktree, STAGE_FLOW_DIRECTORY, `${suiteId}.suite.json`);
		fs.mkdirSync(path.join(worktree, STAGE_FLOW_DIRECTORY), {
			recursive: true,
		});
		fs.writeFileSync(
			suitePath("empty-suite"),
			JSON.stringify({ version: 1, suiteId: "empty-suite", flows: [] }),
		);
		const empty = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			suiteId: "empty-suite",
		});
		expect(empty.status).toBe(409);
		expect(empty.value.code).toBe("suite-manifest-invalid");

		fs.writeFileSync(
			suitePath("conflict-suite"),
			JSON.stringify({
				version: 1,
				suiteId: "conflict-suite",
				parallel: true,
				flows: [{ flowId: "customer-address", sharedData: true }],
			}),
		);
		const conflict = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			suiteId: "conflict-suite",
		});
		expect(conflict.status).toBe(409);
		expect(conflict.value.code).toBe("suite-manifest-invalid");
		const issues = conflict.value.issues as Record<string, unknown>[];
		expect(
			issues.some((issue) => issue.code === "suite-parallel-dependency"),
		).toBe(true);
	});

	test("refuses an unsaved suite id", async () => {
		const { deps } = build("stage.replay");
		const result = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
			suiteId: "not-saved",
		});
		expect(result.status).toBe(409);
		expect(result.value.code).toBe("suite-not-found");
	});

	test("runs every entry through the single-flow path and aggregates pass/refusal", async () => {
		const ready = true;
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (!ready || new URL(request.url).pathname !== "/customers/C-2002")
					return new Response("not found", { status: 404 });
				return new Response(
					'<!doctype html><html><body><h1 data-testid="customer-detail">Customer</h1></body></html>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		try {
			const { deps, worktree } = build(
				"stage.replay",
				`http://127.0.0.1:${server.port}/`,
			);
			linkPackage(worktree);
			await seedRealFlow(worktree);
			const chromium = installedChromium();
			if (chromium !== undefined && deps.installer !== undefined)
				Object.defineProperty(deps.installer, "installedChromium", {
					value: () => chromium,
				});
			fs.writeFileSync(
				path.join(worktree, STAGE_FLOW_DIRECTORY, "crm-regression.suite.json"),
				JSON.stringify({
					version: 1,
					suiteId: "crm-regression",
					parallel: true,
					stopOnFailure: false,
					flows: [
						{
							id: "approved",
							flowId: "customer-address",
							inputs: { path: "/customers/C-2002" },
						},
						{
							id: "unapproved",
							flowId: "customer-address",
							inputs: { path: "/customers/C-1001" },
						},
					],
				}),
			);
			const result = await call(deps, AGENT_BROWSER_STAGE_REPLAY_PATH, {
				suiteId: "crm-regression",
			});
			expect(result.status).toBe(200);
			expect(result.value.suiteId).toBe("crm-regression");
			expect(result.value.parallel).toBe(true);
			expect(result.value.status).toBe("failed");
			expect(typeof result.value.resultEvidenceId).toBe("string");
			const entries = result.value.entries as Record<string, unknown>[];
			expect(entries).toHaveLength(2);
			const approved = entries.find((entry) => entry.id === "approved");
			const unapproved = entries.find((entry) => entry.id === "unapproved");
			expect(approved).toMatchObject({
				flowId: "customer-address",
				status: "passed",
			});
			expect(typeof approved?.resultEvidenceId).toBe("string");
			expect(unapproved).toMatchObject({
				flowId: "customer-address",
				status: "refused",
				code: "flow-inputs-unapproved",
			});
		} finally {
			server.stop(true);
		}
	}, 120_000);
});
