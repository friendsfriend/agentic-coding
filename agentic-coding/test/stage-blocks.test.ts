import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildStageBlockCatalog } from "../src/stage-blocks/catalog.ts";
import {
	catalogArtifact,
	catalogBreakingChangeIssues,
	catalogForRegistry,
	catalogGateIssues,
} from "../src/stage-blocks/catalog-gate.ts";
import {
	type BlockDefinition,
	defineBlock,
} from "../src/stage-blocks/define-block.ts";
import {
	deriveInputSchema,
	type StageBlockPlan,
	validateStageBlockPlan,
} from "../src/stage-blocks/plan.ts";
import {
	createStageBlockRegistry,
	StageBlockRegistryError,
	stageBlockRegistry,
} from "../src/stage-blocks/registry.ts";
import {
	runStageBlockPlan,
	type StageBlockContextHost,
	StageBlockContractError,
	type StageBlockJournalEntry,
} from "../src/stage-blocks/runner.ts";
import {
	type JsonSchema,
	validateSchemaDefinition,
	validateSchemaValue,
} from "../src/stage-blocks/schema.ts";

const ROOT = path.join(import.meta.dir, "..");
const CONTRACT_TEST = "test/stage-blocks.test.ts";

const emptyReturns: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {},
};

function block(
	overrides: Partial<BlockDefinition> & Pick<BlockDefinition, "id" | "run">,
): BlockDefinition {
	return defineBlock({
		version: "1.0.0",
		app: "test",
		title: overrides.id,
		description: `Test block ${overrides.id}.`,
		params: {
			type: "object",
			additionalProperties: false,
			properties: {},
		},
		returns: emptyReturns,
		effects: ["read"],
		idempotent: true,
		examples: [{}],
		contractTest: CONTRACT_TEST,
		...overrides,
	});
}

const loginBlock = block({
	id: "test.login",
	provides: ["logged-in"],
	returns: {
		type: "object",
		additionalProperties: false,
		properties: { role: { type: "string" } },
		required: ["role"],
	},
	examples: [{}],
	run: async (ctx) => {
		await ctx.step("sign in", async () => undefined);
		return { role: ctx.role ?? "clerk" };
	},
});

const workBlock = block({
	id: "test.work",
	requires: ["logged-in"],
	params: {
		type: "object",
		additionalProperties: false,
		properties: { name: { type: "string", minLength: 1 } },
		required: ["name"],
	},
	returns: {
		type: "object",
		additionalProperties: false,
		properties: { id: { type: "string" } },
		required: ["id"],
	},
	examples: [{ name: "sample" }],
	run: async (ctx, args) => {
		const name = args.name;
		if (typeof name !== "string") throw new Error("name is required");
		await ctx.step(
			"do the work",
			async () => {
				await ctx.capture("work done");
			},
			{
				expected: "a result",
				observed: name,
				captures: { name },
			},
		);
		return { id: `id-${name}` };
	},
});

const registry = createStageBlockRegistry([loginBlock, workBlock]);

function host(
	overrides: Partial<StageBlockContextHost> = {},
): StageBlockContextHost {
	return {
		page: {} as StageBlockContextHost["page"],
		expect: () => ({
			toContainText: async () => undefined,
			toBeVisible: async () => undefined,
		}),
		app: "test",
		role: "clerk",
		stage: "stage",
		appUrl: "https://stage.test",
		secret: () => "secret",
		capture: async () => "ev-1",
		...overrides,
	};
}

function plan(): StageBlockPlan {
	return {
		planId: "plan-1",
		flowId: "customer-address",
		inputs: { name: "Ada" },
		steps: [
			{ id: "signin", block: "test.login" },
			{
				id: "work",
				block: "test.work",
				args: { name: "{{ inputs.name }}" },
			},
		],
	};
}

describe("stage block schema", () => {
	test("accepts the supported schema subset and rejects unknown keywords", () => {
		const schema: JsonSchema = {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string", minLength: 1, default: "Ada" },
				count: { type: "integer", minimum: 1, maximum: 3 },
			},
			required: ["name"],
		};
		expect(validateSchemaDefinition(schema)).toEqual([]);
		expect(validateSchemaValue(schema, { name: "Ada", count: 2 })).toEqual([]);
		expect(validateSchemaValue(schema, { name: "", count: 4 })).toHaveLength(2);
		expect(
			validateSchemaDefinition({
				type: "object",
				properties: {},
				additionalProperties: 1,
			})[0]?.code,
		).toBe("schema-additional");
	});

	test("validates defaults, examples and required declarations", () => {
		const issues = validateSchemaDefinition({
			type: "object",
			additionalProperties: false,
			properties: { name: { type: "string", default: 1 } },
			required: ["missing"],
		});
		expect(issues.map((issue) => issue.code)).toContain("schema-default");
		expect(issues.map((issue) => issue.code)).toContain(
			"schema-required-unknown",
		);
	});
});

describe("stage block definitions and registry", () => {
	test("rejects an invalid example and a duplicate id", () => {
		expect(() =>
			block({
				id: "test.invalid",
				params: {
					type: "object",
					additionalProperties: false,
					properties: { name: { type: "string" } },
					required: ["name"],
				},
				examples: [{}],
				run: async () => ({}),
			}),
		).toThrow();
		expect(() => createStageBlockRegistry([loginBlock, loginBlock])).toThrow(
			StageBlockRegistryError,
		);
	});

	test("the generated catalog is current and complete", () => {
		const catalog = buildStageBlockCatalog(stageBlockRegistry);
		expect(catalog.blocks.map((entry) => entry.id)).toEqual([
			"crm.auth.loginAsRole",
			"crm.customer.fillAddress",
			"crm.customer.open",
			"crm.ui.open",
		]);
		expect(catalogGateIssues(catalog, ROOT, stageBlockRegistry)).toEqual([]);
		const generated = fs.readFileSync(
			path.join(ROOT, "src/stage-blocks/catalog.generated.ts"),
			"utf8",
		);
		expect(generated).toBe(catalogArtifact(catalog));
	});

	test("internal blocks are excluded from the public catalog", () => {
		const internal = block({
			id: "test.internal",
			internal: true,
			run: async () => ({}),
		});
		const catalog = buildStageBlockCatalog(
			createStageBlockRegistry([loginBlock, internal]),
		);
		expect(catalog.blocks.map((entry) => entry.id)).toEqual(["test.login"]);
	});

	test("the gate reports a missing contract test", () => {
		const broken = block({
			id: "test.broken",
			contractTest: "test/does-not-exist.ts",
			run: async () => ({}),
		});
		const registry = createStageBlockRegistry([broken]);
		const issues = catalogGateIssues(
			catalogForRegistry(registry),
			ROOT,
			registry,
		);
		expect(issues.some((issue) => issue.field === "contractTest")).toBe(true);
	});

	test("refuses a breaking change at the same version and accepts a major bump", () => {
		const before = catalogForRegistry(
			createStageBlockRegistry([
				block({ id: "test.contract", run: async () => ({}) }),
			]),
		);
		const changedParams = block({
			id: "test.contract",
			params: {
				type: "object",
				additionalProperties: false,
				properties: { name: { type: "string" }, extra: { type: "string" } },
				required: ["name"],
			},
			examples: [{ name: "Ada", extra: "x" }],
			run: async () => ({}),
		});
		const sameVersion = catalogForRegistry(
			createStageBlockRegistry([changedParams]),
		);
		const unbumped = catalogBreakingChangeIssues(before, sameVersion);
		expect(unbumped).toHaveLength(1);
		expect(unbumped[0]?.message).toContain("params");
		expect(unbumped[0]?.message).toContain("without a major version bump");

		const bumped = block({
			id: "test.contract",
			version: "2.0.0",
			params: changedParams.params,
			examples: changedParams.examples,
			run: async () => ({}),
		});
		const bumpedCatalog = catalogForRegistry(
			createStageBlockRegistry([bumped]),
		);
		expect(catalogBreakingChangeIssues(before, bumpedCatalog)).toEqual([]);

		const unrelatedChange = block({
			id: "test.contract",
			description: "A different, still non-breaking description.",
			run: async () => ({}),
		});
		const descriptionOnly = catalogForRegistry(
			createStageBlockRegistry([unrelatedChange]),
		);
		expect(catalogBreakingChangeIssues(before, descriptionOnly)).toEqual([]);
	});
});

describe("stage block plan validation", () => {
	test("resolves bindings and derives the input schema", () => {
		const result = validateStageBlockPlan(plan(), { registry });
		expect(result.issues).toEqual([]);
		expect(result.plan?.steps.map((step) => step.id)).toEqual([
			"signin",
			"work",
		]);
		expect(result.plan?.versions).toEqual({
			"test.login": "1.0.0",
			"test.work": "1.0.0",
		});
		const derived = deriveInputSchema(plan(), registry);
		expect(derived.issues).toEqual([]);
		expect(derived.schema).toMatchObject({
			type: "object",
			required: ["name"],
			properties: { name: { type: "string", minLength: 1 } },
		});
	});

	test("refuses missing inputs, forward references and fragments", () => {
		const missing = validateStageBlockPlan(
			{
				steps: [
					{ block: "test.login" },
					{ block: "test.work", args: { name: "{{ inputs.absent }}" } },
				],
			},
			{ registry },
		);
		expect(missing.issues.map((issue) => issue.code)).toContain(
			"input-missing",
		);
		const forward = validateStageBlockPlan(
			{
				steps: [
					{ block: "test.login" },
					{
						block: "test.work",
						args: { name: "{{ steps.later.outputs.id }}" },
					},
					{ id: "later", block: "test.login" },
				],
			},
			{ registry },
		);
		expect(forward.issues.map((issue) => issue.code)).toContain(
			"output-reference-forward",
		);
		const fragment = validateStageBlockPlan(
			{
				steps: [{ block: "test.login", args: { name: "pre {{ inputs.x }}" } }],
			},
			{ registry },
		);
		expect(fragment.issues.map((issue) => issue.code)).toContain(
			"binding-invalid",
		);
	});

	test("enforces state, application, role and write policy", () => {
		const unmet = validateStageBlockPlan(
			{ steps: [{ block: "test.work", args: { name: "x" } }] },
			{ registry },
		);
		expect(unmet.issues.map((issue) => issue.code)).toContain(
			"block-requires-unmet",
		);
		const writer = block({
			id: "test.write",
			effects: ["write"],
			idempotent: false,
			run: async () => ({}),
		});
		const writerRegistry = createStageBlockRegistry([writer]);
		const readOnly = validateStageBlockPlan(
			{ steps: [{ block: "test.write" }] },
			{
				registry: writerRegistry,
				policy: {
					stage: "stage",
					access: "read-only",
					writeAllowed: true,
					role: "clerk",
					apps: { test: { roles: ["clerk"] } },
				},
			},
		);
		expect(readOnly.issues.map((issue) => issue.code)).toContain(
			"stage-read-only",
		);
		const unapproved = validateStageBlockPlan(
			{ steps: [{ block: "test.write" }] },
			{
				registry: writerRegistry,
				policy: {
					stage: "stage",
					access: "writable",
					writeAllowed: false,
					role: "clerk",
					apps: { test: { roles: ["clerk"] } },
				},
			},
		);
		expect(unapproved.issues.map((issue) => issue.code)).toContain(
			"stage-action-not-approved",
		);
		const wrongRole = validateStageBlockPlan(plan(), {
			registry,
			policy: {
				stage: "stage",
				access: "read-only",
				writeAllowed: false,
				role: "manager",
				apps: { test: { roles: ["clerk"] } },
			},
		});
		expect(wrongRole.issues.map((issue) => issue.code)).toContain(
			"stage-role-mismatch",
		);
	});

	test("refuses configured secrets in inputs and args", () => {
		const result = validateStageBlockPlan(
			{
				inputs: { name: "s3cr3t-value" },
				steps: [
					{ block: "test.login" },
					{
						block: "test.work",
						args: { name: "{{ inputs.name }}" },
					},
				],
			},
			{ registry, secretValues: ["s3cr3t-value"] },
		);
		expect(result.issues.map((issue) => issue.code)).toContain(
			"plan-secret-literal",
		);
	});
});

describe("stage block runner", () => {
	test("runs every block and journals each sub-step", async () => {
		const validated = validateStageBlockPlan(plan(), { registry });
		if (!validated.plan) throw new Error("plan did not validate");
		const entries: StageBlockJournalEntry[] = [];
		const result = await runStageBlockPlan({
			plan: validated.plan,
			stage: "stage",
			contextFor: async () => host(),
			journal: {
				append: async (entry) => {
					entries.push(entry);
					return { seq: entries.length };
				},
			},
		});
		expect(result.status).toBe("passed");
		expect(result.steps.map((step) => step.status)).toEqual([
			"passed",
			"passed",
		]);
		expect(result.steps[1]?.outputs).toEqual({ id: "id-Ada" });
		expect(entries.map((entry) => entry.subStep)).toEqual([
			"sign in",
			"do the work",
		]);
		expect(entries[1]?.block).toBe("test.work");
		expect(entries[1]?.planId).toBe("plan-1");
		expect(entries[1]?.evidence).toEqual(["ev-1"]);
	});

	test("stops after a failure, skips later steps and captures failure evidence", async () => {
		const failing = block({
			id: "test.fail",
			effects: ["write"],
			idempotent: false,
			run: async (ctx) => {
				await ctx.step("attempt the write", async () => {
					throw new Error("save rejected");
				});
				return {};
			},
		});
		const after = block({
			id: "test.after",
			run: async (ctx) => {
				await ctx.step("after", async () => undefined);
				return {};
			},
		});
		const failingRegistry = createStageBlockRegistry([
			loginBlock,
			failing,
			after,
		]);
		const validated = validateStageBlockPlan(
			{
				steps: [
					{ block: "test.login" },
					{ block: "test.fail" },
					{ block: "test.after" },
				],
			},
			{ registry: failingRegistry },
		);
		if (!validated.plan) throw new Error("plan did not validate");
		const result = await runStageBlockPlan({
			plan: validated.plan,
			stage: "stage",
			contextFor: async () => host(),
			failureEvidence: async () => ({ evidenceIds: ["failure-evidence"] }),
		});
		expect(result.status).toBe("failed");
		expect(result.steps.map((step) => step.status)).toEqual([
			"passed",
			"failed",
			"skipped",
		]);
		expect(result.failure?.message).toContain("save rejected");
		expect(result.steps[1]?.evidenceIds).toContain("failure-evidence");
	});

	test("retries one idempotent read, but never a write", async () => {
		let attempts = 0;
		const flaky = block({
			id: "test.flaky",
			run: async (ctx) => {
				attempts += 1;
				await ctx.step("read once", async () => {
					if (attempts === 1) throw new Error("transient read");
				});
				return {};
			},
		});
		const flakyRegistry = createStageBlockRegistry([flaky]);
		const validated = validateStageBlockPlan(
			{ steps: [{ block: "test.flaky" }] },
			{ registry: flakyRegistry },
		);
		if (!validated.plan) throw new Error("plan did not validate");
		const result = await runStageBlockPlan({
			plan: validated.plan,
			stage: "stage",
			contextFor: async () => host(),
		});
		expect(result.status).toBe("passed");
		expect(result.steps[0]?.retries).toBe(1);
		expect(attempts).toBe(2);
	});

	test("a block that emits no sub-step violates the contract", async () => {
		const silent = block({
			id: "test.silent",
			run: async () => ({}),
		});
		const silentRegistry = createStageBlockRegistry([silent]);
		const validated = validateStageBlockPlan(
			{ steps: [{ block: "test.silent" }] },
			{ registry: silentRegistry },
		);
		if (!validated.plan) throw new Error("plan did not validate");
		const result = await runStageBlockPlan({
			plan: validated.plan,
			stage: "stage",
			contextFor: async () => host(),
		});
		expect(result.status).toBe("failed");
		expect(result.failure?.message).toContain("emitted no sub-step");
	});

	test("a capture outside a sub-step is a contract error", async () => {
		const invalid = block({
			id: "test.capture",
			run: async (ctx) => {
				await ctx.capture("outside");
				return {};
			},
		});
		const invalidRegistry = createStageBlockRegistry([invalid]);
		const validated = validateStageBlockPlan(
			{ steps: [{ block: "test.capture" }] },
			{ registry: invalidRegistry },
		);
		if (!validated.plan) throw new Error("plan did not validate");
		const result = await runStageBlockPlan({
			plan: validated.plan,
			stage: "stage",
			contextFor: async () => host(),
		});
		expect(result.status).toBe("failed");
		expect(result.failure?.message).toContain("must happen inside");
		expect(StageBlockContractError).toBeDefined();
	});
});

/** A minimal in-memory `BlockPage` built only for the three pilot blocks'
 * exact locator/assertion surface (`add-stage-flow-blocks` tasks 5.6/9.4): a
 * consumer smoke test that chains `loginAsRole` → `openCustomer` →
 * `fillCustomerAddress` against the real pilot blocks and verifies the final
 * postcondition, including the save-then-reload distinction a real backend
 * makes — `pendingAddress` is form state a reload loses; `savedAddress` is
 * what the (fake) server persisted and a reload must still show. */
function fakeCrmPage(): {
	readonly page: StageBlockContextHost["page"];
	readonly expect: StageBlockContextHost["expect"];
} {
	const state: {
		loggedIn: boolean;
		username?: string;
		password?: string;
		customerId?: string;
		pendingAddress: Partial<{
			street: string;
			city: string;
			postalCode: string;
			country: string;
		}>;
		savedAddress?: {
			street: string;
			city: string;
			postalCode: string;
			country: string;
		};
	} = { loggedIn: false, pendingAddress: {} };
	let url = "https://stage.test/";

	function slot(
		text: () => string,
		visible: () => boolean,
		onFill?: (value: string) => void,
		onClick?: () => void,
	): ReturnType<StageBlockContextHost["page"]["getByLabel"]> {
		return {
			click: async () => {
				onClick?.();
			},
			fill: async (value: string) => {
				onFill?.(value);
			},
			press: async () => undefined,
			selectOption: async () => undefined,
			textContent: async () => text(),
			innerText: async () => text(),
			isVisible: async () => visible(),
			waitFor: async () => {
				if (!visible()) throw new Error("element is not visible");
			},
		};
	}

	const page: StageBlockContextHost["page"] = {
		goto: async (target: string) => {
			url = target;
			const match = /\/customers\/([^/]+)/.exec(target);
			if (match?.[1] !== undefined) state.customerId = match[1];
		},
		url: () => url,
		title: async () => "Fake CRM",
		getByRole: (role, options) => {
			if (role === "button" && options?.name === "Sign in")
				return slot(
					() => "",
					() => true,
					undefined,
					() => {
						state.loggedIn = true;
					},
				);
			if (role === "button" && options?.name === "Save address")
				return slot(
					() => "",
					() => true,
					undefined,
					() => {
						state.savedAddress = {
							street: state.pendingAddress.street ?? "",
							city: state.pendingAddress.city ?? "",
							postalCode: state.pendingAddress.postalCode ?? "",
							country: state.pendingAddress.country ?? "",
						};
					},
				);
			return slot(
				() => "",
				() => true,
			);
		},
		getByLabel: (label) => {
			if (label === "Username")
				return slot(
					() => state.username ?? "",
					() => true,
					(value) => {
						state.username = value;
					},
				);
			if (label === "Password")
				return slot(
					() => state.password ?? "",
					() => true,
					(value) => {
						state.password = value;
					},
				);
			const field = (
				{
					Street: "street",
					City: "city",
					"Postal code": "postalCode",
					Country: "country",
				} as const
			)[label];
			if (field !== undefined)
				return slot(
					() => state.pendingAddress[field] ?? "",
					() => true,
					(value) => {
						state.pendingAddress[field] = value;
					},
				);
			return slot(
				() => "",
				() => true,
			);
		},
		getByTestId: (testId) => {
			if (testId === "session-user")
				return slot(
					() => (state.loggedIn ? "Signed in as clerk" : ""),
					() => state.loggedIn,
				);
			if (testId === "customer-detail")
				return slot(
					() => `Customer ${state.customerId ?? ""}`,
					() => state.customerId !== undefined,
				);
			if (testId === "address-saved")
				return slot(
					() => "Address saved",
					() => state.savedAddress !== undefined,
				);
			if (testId === "customer-address")
				return slot(
					() =>
						state.savedAddress === undefined
							? ""
							: `${state.savedAddress.street}, ${state.savedAddress.city} ${state.savedAddress.postalCode}`,
					() => state.savedAddress !== undefined,
				);
			return slot(
				() => "",
				() => true,
			);
		},
		getByText: () =>
			slot(
				() => "",
				() => true,
			),
		locator: () =>
			slot(
				() => "",
				() => true,
			),
		reload: async () => {
			// A reload loses unsaved form state and keeps only what the (fake)
			// server persisted — the exact distinction `fillCustomerAddress`'s own
			// postcondition depends on.
			state.pendingAddress = {};
		},
		waitForTimeout: async () => undefined,
	};
	return {
		page,
		expect: (locator) => ({
			toContainText: async (expected: string) => {
				const text = await locator.textContent();
				if (!(text ?? "").includes(expected))
					throw new Error(
						`expected text to contain ${JSON.stringify(expected)}, got ${JSON.stringify(text)}`,
					);
			},
			toBeVisible: async () => {
				if (!(await locator.isVisible()))
					throw new Error("expected the element to be visible");
			},
		}),
	};
}

describe("stage block pilot consumer smoke test (add-stage-flow-blocks)", () => {
	test("chains loginAsRole, openCustomer and fillCustomerAddress and verifies the saved address survives a reload", async () => {
		const plan: StageBlockPlan = {
			planId: "plan-pilot-smoke",
			steps: [
				{ id: "login", block: "crm.auth.loginAsRole", args: { role: "clerk" } },
				{
					id: "open",
					block: "crm.customer.open",
					args: { customerId: "C-9001" },
				},
				{
					id: "address",
					block: "crm.customer.fillAddress",
					args: {
						customerId: "{{ steps.open.outputs.customerId }}",
						street: "Teststr. 9",
						city: "Berlin",
						postalCode: "10115",
						country: "DE",
					},
				},
			],
		};
		const validated = validateStageBlockPlan(plan, {
			registry: stageBlockRegistry,
			policy: {
				stage: "crm-stage",
				access: "writable",
				writeAllowed: true,
				role: "clerk",
				apps: { crm: { roles: ["clerk"] } },
			},
		});
		if (!validated.plan) throw new Error(JSON.stringify(validated.issues));
		const entries: StageBlockJournalEntry[] = [];
		const context = fakeCrmPage();
		const result = await runStageBlockPlan({
			plan: validated.plan,
			stage: "crm-stage",
			contextFor: async () => ({
				page: context.page,
				expect: context.expect,
				app: "crm",
				role: "clerk",
				stage: "crm-stage",
				appUrl: "https://stage.test",
				secret: (name) =>
					name === "STAGE_USERNAME" ? "clerk-user" : "clerk-pass",
				capture: async () => "ev-1",
			}),
			journal: {
				append: async (entry) => {
					entries.push(entry);
					return { seq: entries.length };
				},
			},
		});
		expect(result.status).toBe("passed");
		expect(result.steps.map((step) => step.status)).toEqual([
			"passed",
			"passed",
			"passed",
		]);
		expect(result.steps[1]?.outputs).toMatchObject({ customerId: "C-9001" });
		expect(result.steps[2]?.outputs).toMatchObject({
			customerId: "C-9001",
			street: "Teststr. 9",
			city: "Berlin",
			postalCode: "10115",
			country: "DE",
		});
		expect(entries.map((entry) => entry.block)).toEqual([
			"crm.auth.loginAsRole",
			"crm.auth.loginAsRole",
			"crm.customer.open",
			"crm.customer.fillAddress",
			"crm.customer.fillAddress",
			"crm.customer.fillAddress",
		]);
	});
});
