import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STAGE_BLOCK_EXAMPLE } from "../src/agent-host/browser-tools.ts";
import {
	compileDataBlock,
	DATA_BLOCK_MAX_BYTES,
	DATA_BLOCK_MAX_DELAY_MS,
	DATA_BLOCK_MAX_OPERATIONS,
	DATA_BLOCK_MAX_WAIT_MS,
	interpretDataBlock,
	type StageDataBlockDocument,
	StageDataBlockError,
	validateDataBlock,
} from "../src/stage-blocks/data-block.ts";
import {
	appendStageBlockProof,
	approvedBlockPath,
	promoteDataBlock,
	promoteStageBlockDrafts,
	readApprovedBlocks,
	readStageBlockDraft,
	readStageBlockDrafts,
	StageBlockStoreError,
	saveStageBlockDraft,
	storedDigest,
} from "../src/stage-blocks/data-store.ts";
import type {
	BlockLocator,
	BlockPage,
	StageContext,
} from "../src/stage-blocks/define-block.ts";
import {
	blockDigest,
	blockMetadata,
} from "../src/stage-blocks/define-block.ts";
import { pinnedDataBlock } from "../src/stage-blocks/fixture.ts";
import { parseFlowManifest } from "../src/stage-blocks/flow.ts";
import { generateFlow } from "../src/stage-blocks/flow-generator.ts";
import { flowEligibility } from "../src/stage-blocks/flow-registry.ts";
import {
	blockPlanFromRoute,
	validateStageBlockPlan,
} from "../src/stage-blocks/plan.ts";
import { createStageBlockRegistry } from "../src/stage-blocks/registry.ts";
import { flowSourceFromRoute } from "./support/flow-source-fixture.ts";

function document(
	overrides: Partial<StageDataBlockDocument> = {},
): StageDataBlockDocument {
	return {
		format: 1,
		id: "crm.customer.readAddress",
		version: "1.0.0",
		app: "crm",
		roles: ["clerk"],
		title: "Read one customer's saved address",
		description: "Opens one customer and reads the address the app stored.",
		effects: ["read"],
		idempotent: true,
		params: {
			type: "object",
			additionalProperties: false,
			properties: {
				customerId: { type: "string", minLength: 1 },
			},
			required: ["customerId"],
		},
		returns: {
			type: "object",
			additionalProperties: false,
			properties: { street: { type: "string" } },
			required: ["street"],
		},
		examples: [{ customerId: "C-1001" }],
		postcondition: "the customer detail page shows the stored street",
		operations: [
			{
				op: "step",
				label: "open the customer",
				expected: "the detail page is visible",
				operations: [
					{ op: "goto", path: "/customers/{{ args.customerId }}" },
					{
						op: "expectVisible",
						target: { role: "heading", name: "Customer detail" },
					},
				],
			},
			{
				op: "step",
				label: "read the address",
				operations: [
					{
						op: "read",
						target: { testId: "street" },
						into: "street",
					},
					{
						op: "expectText",
						target: { testId: "street" },
						text: "Main",
					},
				],
			},
		],
		...overrides,
	};
}

/** A page that records every call and never fails unless told to. */
function fakePage(options: { readonly failText?: string } = {}) {
	const calls: string[] = [];
	const locator = (name: string): BlockLocator => ({
		click: async () => {
			calls.push(`click:${name}`);
		},
		fill: async (value) => {
			calls.push(`fill:${name}=${value}`);
		},
		type: async (value, typeOptions) => {
			calls.push(`type:${name}=${value}@${typeOptions?.delayMs ?? 0}`);
		},
		press: async (key) => {
			calls.push(`press:${name}=${key}`);
		},
		selectOption: async (values) => {
			calls.push(`select:${name}=${String(values)}`);
		},
		textContent: async () => {
			if (options.failText !== undefined && name === options.failText)
				throw new Error("the element never appeared");
			return "Main street";
		},
		innerText: async () => "Main street",
		isVisible: async () => true,
		waitFor: async () => undefined,
	});
	const page: BlockPage = {
		goto: async (url) => {
			calls.push(`goto:${url}`);
		},
		url: () => "https://crm.test",
		title: async () => "CRM",
		getByRole: (role, roleOptions) =>
			locator(`role=${role}:${roleOptions?.name ?? ""}`),
		getByLabel: (label) => locator(`label=${label}`),
		getByTestId: (testId) => locator(`testId=${testId}`),
		getByText: (text) => locator(`text=${text}`),
		locator: (selector) => locator(`selector=${selector}`),
		reload: async () => undefined,
		waitForTimeout: async (ms) => {
			calls.push(`wait:${ms}`);
		},
	};
	return { page, calls };
}

function context(options: { readonly failText?: string } = {}) {
	const { page, calls } = fakePage(options);
	const steps: { label: string; details?: unknown; failed?: boolean }[] = [];
	const evidence: string[] = [];
	const ctx: StageContext = {
		page,
		expect: () => ({
			toContainText: async (expected) => {
				calls.push(`expectText:${expected}`);
			},
			toBeVisible: async () => {
				calls.push("expectVisible");
			},
		}),
		app: "crm",
		role: "clerk",
		stage: "crm-int",
		appUrl: "https://crm.test",
		run: {
			planId: "plan-1",
			routeStepId: "read",
			blockId: "crm.customer.readAddress",
			blockVersion: "1.0.0",
			index: 0,
		},
		step: async (label, fn, details) => {
			const entry: { label: string; details?: unknown; failed?: boolean } = {
				label,
				...(typeof details === "function" ? { details: details() } : {}),
			};
			steps.push(entry);
			try {
				return await fn();
			} catch (error) {
				entry.failed = true;
				throw error;
			}
		},
		capture: async (label) => {
			const id = `ev-${evidence.length + 1}`;
			evidence.push(label);
			return id;
		},
		secret: (name) => `secret-${name}`,
	};
	return { ctx, calls, steps, evidence };
}

describe("stage data blocks: the document contract", () => {
	test("the example the stage_block_save tool shows the tester is a valid document", () => {
		const result = validateDataBlock(
			JSON.parse(JSON.stringify(STAGE_BLOCK_EXAMPLE)),
		);
		expect(result.ok ? [] : result.issues).toEqual([]);
	});

	test("a reviewed document compiles to the same frozen definition a checked-in block has", () => {
		const compiled = compileDataBlock(document());
		expect(compiled.id).toBe("crm.customer.readAddress");
		expect(compiled.version).toBe("1.0.0");
		expect(compiled.app).toBe("crm");
		expect(compiled.roles).toEqual(["clerk"]);
		expect(compiled.effects).toEqual(["read"]);
		const metadata = blockMetadata(compiled);
		expect(metadata.postcondition).toBe(
			"the customer detail page shows the stored street",
		);
		expect(metadata.kind).toBe("data");
		expect(compiled.data?.format).toBe(1);
		// A data block declares no contract test: its reviewed document is the test.
		expect(compiled.contractTest).toBeUndefined();
	});

	test("refuses an operation, a byte or a nesting bound it exceeds", () => {
		const tooMany = {
			op: "step" as const,
			label: "noisy",
			operations: [
				{ op: "capture" as const, label: "one" },
				...Array.from({ length: 2 }, () => ({
					op: "wait" as const,
					ms: 1,
				})),
				{
					op: "expectVisible" as const,
					target: { testId: "x" },
				},
			].slice(0, 4),
		};
		const many = validateDataBlock(
			document({
				operations: Array.from(
					{ length: DATA_BLOCK_MAX_OPERATIONS + 1 },
					() => tooMany,
				),
			}),
		);
		expect(many.ok).toBe(false);
		expect(many.issues.map((issue) => issue.code)).toContain(
			"data-block-operations",
		);

		const nested = validateDataBlock({
			...document(),
			operations: [
				{
					op: "optional",
					reason: "deep",
					operations: [
						{
							op: "step",
							label: "inner",
							operations: [{ op: "capture", label: "one" }],
						},
					],
				},
			],
		});
		expect(nested.ok).toBe(false);
		// A nested step is not an action: the document is two levels deep by
		// construction (step -> actions), so nothing can nest further.
		expect(nested.issues.map((issue) => issue.code)).toContain(
			"data-block-operation",
		);

		const oversized = validateDataBlock({
			...document(),
			description: "x".repeat(DATA_BLOCK_MAX_BYTES),
		});
		expect(oversized.ok).toBe(false);
		expect(oversized.issues[0]?.message).toContain("bytes");
	});

	test("a document whose schema is not an object is refused, never a crash", () => {
		// Every one of these arrives from a document, a flow sidecar or the store,
		// and each one used to throw out of `validateDataBlock` instead of being
		// refused — which turns a bad file into a crash on the replay path and a
		// 500 instead of a 400 on `stage_block_save` (`QUALITY-001`).
		const cases: [string, Record<string, unknown>][] = [
			["params", { params: "nope" }],
			["params", { params: null }],
			["returns", { returns: 7 }],
			["returns", { returns: [] }],
		];
		for (const [name, overrides] of cases) {
			const validation = validateDataBlock({ ...document(), ...overrides });
			expect(validation.ok).toBe(false);
			expect(validation.issues.map((entry) => entry.path)).toContain(name);
			expect(validation.issues.map((entry) => entry.code)).toContain(
				"data-block-schema",
			);
		}
	});

	test("bounds a delay and a wait so a data block cannot hang the run", () => {
		const delay = validateDataBlock(
			document({
				operations: [
					{
						op: "step",
						label: "type",
						operations: [
							{
								op: "type",
								target: { testId: "name" },
								value: "Ada",
								delayMs: DATA_BLOCK_MAX_DELAY_MS + 1,
							},
							{ op: "expectVisible", target: { testId: "name" } },
						],
					},
				],
			}),
		);
		expect(delay.ok).toBe(false);
		expect(delay.issues.map((issue) => issue.code)).toContain(
			"data-block-delay",
		);

		const wait = validateDataBlock(
			document({
				operations: [
					{
						op: "step",
						label: "wait",
						operations: [
							{ op: "wait", ms: DATA_BLOCK_MAX_WAIT_MS + 1 },
							{ op: "expectVisible", target: { testId: "name" } },
						],
					},
				],
			}),
		);
		expect(wait.ok).toBe(false);
		expect(wait.issues.map((issue) => issue.code)).toContain("data-block-wait");
	});

	test("requires a step, an expectation and no destructive effect", () => {
		const noStep = validateDataBlock(
			document({
				operations: [
					{
						op: "optional",
						reason: "cleanup",
						operations: [{ op: "click", target: { testId: "close" } }],
					},
				],
			}),
		);
		expect(noStep.ok).toBe(false);
		expect(noStep.issues.map((issue) => issue.code)).toContain(
			"data-block-step",
		);

		const noExpectation = validateDataBlock(
			document({
				operations: [
					{
						op: "step",
						label: "open",
						operations: [{ op: "goto", path: "/a" }],
					},
				],
			}),
		);
		expect(noExpectation.ok).toBe(false);
		expect(noExpectation.issues.map((issue) => issue.code)).toContain(
			"data-block-expectation",
		);

		const destructive = validateDataBlock(
			document({ effects: ["read", "destructive"] }),
		);
		expect(destructive.ok).toBe(false);
		expect(destructive.issues.map((issue) => issue.code)).toContain(
			"data-block-effects",
		);
	});

	test("refuses a target qualifier that would do nothing, and a hidden wait", () => {
		const exact = validateDataBlock(
			document({
				operations: [
					{
						op: "step",
						label: "click the row",
						operations: [
							{
								op: "click",
								target: { label: "Street", exact: true },
							},
							{ op: "expectVisible", target: { testId: "row" } },
						],
					},
				],
			}),
		);
		expect(exact.ok).toBe(false);
		expect(exact.issues).toEqual([
			{
				code: "data-block-target",
				path: "operations[0].operations[0].target.exact",
				message: "exact is only meaningful on a role or text target",
			},
		]);
		const hidden = validateDataBlock(
			document({
				operations: [
					{
						op: "step",
						label: "wait for the banner to go",
						operations: [
							{
								op: "waitFor",
								target: { testId: "banner" },
								state: "hidden",
							},
							{ op: "expectVisible", target: { testId: "row" } },
						],
					},
				],
			}),
		);
		expect(hidden.ok).toBe(false);
		expect(hidden.issues[0]?.message).toContain(
			"state hidden is not supported by the stage page",
		);
	});

	test("refuses an unknown id, a foreign field and an unbound argument", () => {
		expect(validateDataBlock(document({ id: "nope" })).ok).toBe(false);
		expect(validateDataBlock(document({ effects: ["read"] })).ok).toBe(true);
		const extra = validateDataBlock({
			...document(),
			secret: "sk-live-1",
		} as unknown as StageDataBlockDocument);
		expect(extra.ok).toBe(false);
		expect(extra.issues.map((issue) => issue.code)).toContain(
			"data-block-unknown-field",
		);
		const unbound = validateDataBlock(
			document({
				operations: [
					{
						op: "step",
						label: "open",
						operations: [
							{ op: "goto", path: "/c/{{ args.missing }}" },
							{ op: "expectVisible", target: { testId: "x" } },
						],
					},
				],
			}),
		);
		expect(unbound.ok).toBe(false);
		expect(unbound.issues.map((issue) => issue.code)).toContain(
			"data-block-unknown-argument",
		);
	});

	test("the digest covers the document, so a reworded block is a new digest", () => {
		const first = compileDataBlock(document());
		const second = compileDataBlock(
			document({ postcondition: "the street stays the same" }),
		);
		expect(blockDigest(first)).not.toBe(blockDigest(second));
		expect(blockDigest(first)).toBe(blockDigest(compileDataBlock(document())));
		expect(storedDigest(document())).toBe(storedDigest(document()));
		expect(storedDigest(document())).not.toBe(
			storedDigest(document({ version: "1.0.1" })),
		);
	});
});

describe("stage data blocks: interpretation", () => {
	test("every step becomes exactly one journal entry with its own details", async () => {
		const { ctx, calls, steps } = context();
		const outputs = await interpretDataBlock(ctx, document(), {
			customerId: "C-1001",
		});
		expect(steps.map((step) => step.label)).toEqual([
			"open the customer",
			"read the address",
		]);
		expect(steps[0]?.details).toMatchObject({
			expected: "the detail page is visible",
		});
		expect(calls).toContain("goto:https://crm.test/customers/C-1001");
		expect(outputs).toEqual({ street: "Main street" });
	});

	test("a type action presses keys at the documented default delay", async () => {
		const { ctx, calls } = context();
		await interpretDataBlock(
			ctx,
			document({
				returns: {
					type: "object",
					additionalProperties: false,
					properties: {},
				},
				operations: [
					{
						op: "step",
						label: "type the street",
						operations: [
							{ op: "fill", target: { testId: "street" }, value: "Main" },
							{ op: "type", target: { testId: "street" }, value: "str." },
							{
								op: "type",
								target: { testId: "street" },
								value: "1",
								delayMs: 120,
							},
							{ op: "press", target: { testId: "street" }, key: "Enter" },
							{ op: "expectVisible", target: { testId: "street" } },
						],
					},
				],
			}),
			{ customerId: "C-1" },
		);
		expect(calls).toContain("press:testId=street=Enter");
		expect(calls.filter((call) => call.startsWith("type:"))).toEqual([
			// A document that omits the delay still presses keys one by one, so a
			// masked or autocompleted field is not filled instantly (`OSV-011`).
			"type:testId=street=str.@50",
			"type:testId=street=1@120",
		]);
	});

	test("a failed expectation names the step it belongs to", async () => {
		const { ctx, steps } = context({ failText: "testId=street" });
		const failing = document({
			operations: [
				{
					op: "step",
					label: "read the address",
					operations: [
						{ op: "read", target: { testId: "street" }, into: "street" },
						{ op: "expectText", target: { testId: "street" }, text: "Main" },
					],
				},
			],
		});
		await expect(
			interpretDataBlock(ctx, failing, { customerId: "C-1" }),
		).rejects.toThrow("the element never appeared");
		// The failure is attributed to the step it happened in, not just raised:
		// the runner names that step in the journal and the heal packet (`TQV-008`).
		expect(steps).toEqual([
			expect.objectContaining({ label: "read the address", failed: true }),
		]);
	});

	test("an optional group records its own entry and swallows its failure", async () => {
		const { ctx, steps } = context({ failText: "testId=dismiss" });
		const outputs = await interpretDataBlock(
			ctx,
			document({
				returns: {
					type: "object",
					additionalProperties: false,
					properties: {},
				},
				operations: [
					{
						op: "step",
						label: "open the customer",
						operations: [
							{ op: "goto", path: "/customers/{{ args.customerId }}" },
							{ op: "expectVisible", target: { testId: "street" } },
						],
					},
					{
						op: "optional",
						reason: "dismiss the cookie banner when it shows",
						operations: [
							{ op: "click", target: { testId: "dismiss" } },
							{ op: "read", target: { testId: "dismiss" }, into: "x" },
						],
					},
				],
			}),
			{ customerId: "C-1001" },
		);
		expect(outputs).toEqual({});
		expect(steps.map((step) => step.label)).toContain(
			"optional: dismiss the cookie banner when it shows",
		);
	});

	test("refuses outputs that do not satisfy the declared returns", async () => {
		const { ctx } = context();
		await expect(
			interpretDataBlock(
				ctx,
				document({
					returns: {
						type: "object",
						additionalProperties: false,
						properties: { orderId: { type: "string" } },
						required: ["orderId"],
					},
				}),
				{ customerId: "C-1001" },
			),
		).rejects.toBeInstanceOf(StageDataBlockError);
	});

	test("resolves a secret by name only, never as a literal", async () => {
		const { ctx, calls } = context();
		const secretDocument = document({
			returns: {
				type: "object",
				additionalProperties: false,
				properties: {},
			},
			operations: [
				{
					op: "step",
					label: "type the password",
					operations: [
						{
							op: "fill",
							target: { label: "Password" },
							value: { secret: "CRM_PASSWORD" },
						},
						{ op: "expectVisible", target: { testId: "street" } },
					],
				},
			],
		});
		await interpretDataBlock(ctx, secretDocument, {});
		expect(calls).toContain("fill:label=Password=secret-CRM_PASSWORD");
		const literal = validateDataBlock({
			...document(),
			operations: [
				{
					op: "step",
					label: "type the password",
					operations: [
						{
							op: "fill",
							target: { label: "Password" },
							value: { secret: "sk-live-1" },
						},
						{ op: "expectVisible", target: { testId: "street" } },
					],
				},
			],
		} as StageDataBlockDocument);
		expect(literal.ok).toBe(false);
		expect(literal.issues.map((issue) => issue.code)).toContain(
			"data-block-value",
		);
	});
});

describe("stage data blocks: the draft store", () => {
	const root = () =>
		fs.mkdtempSync(path.join(os.tmpdir(), "stage-block-store-"));
	/** Every promotion needs a passed proof from this run. */
	const prove = (
		dataRoot: string,
		workflowId: string,
		block: ReturnType<typeof document>,
		status: "passed" | "failed" = "passed",
	) =>
		appendStageBlockProof({
			dataRoot,
			workflowId,
			document: block,
			proof: {
				stage: "crm-int",
				runId: workflowId,
				status,
				at: "2026-01-02T00:00:00.000Z",
				journalIds: [3],
				evidenceIds: ["ev-1"],
			},
		});
	/** The claim an approved report makes for one document: the promotion publishes
	 * exactly the reviewed body, so a claim names id, version and digest. */
	const claimOf = (block: ReturnType<typeof document>) => ({
		id: block.id,
		version: block.version,
		digest: storedDigest(block),
	});

	test("a draft round-trips with its document and keeps five proofs", () => {
		const dataRoot = root();
		const saved = saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		expect(saved.replaced).toBe(false);
		const read = readStageBlockDrafts(dataRoot, "run-1");
		expect(read.drafts.map((draft) => draft.document.id)).toEqual([
			"crm.customer.readAddress",
		]);
		for (let index = 0; index < 7; index += 1)
			expect(
				appendStageBlockProof({
					dataRoot,
					workflowId: "run-1",
					document: document(),
					proof: {
						stage: "crm-int",
						runId: `run-${index}`,
						status: "passed",
						at: "2026-01-01T00:00:00.000Z",
						journalIds: [],
						evidenceIds: [],
					},
				}).draft?.proofs,
			).toBeDefined();
		const proofs = readStageBlockDrafts(dataRoot, "run-1").drafts[0]?.draft
			.proofs;
		expect(proofs).toHaveLength(5);
		expect(proofs?.at(-1)?.runId).toBe("run-6");
		// Re-saving the same body keeps the proof history: each proof is of this
		// exact document, and the re-save changed nothing it executed.
		const same = saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		expect(same.replaced).toBe(true);
		expect(same.draft.proofs).toHaveLength(5);
		// A save that changes the body drops them. The proofs name the version and
		// digest they ran, so a proof of 1.0.0 can never stand in for 1.1.0 — that
		// is what stops an edited block being approved on someone else's run
		// (`SEC-004`).
		const again = saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document({ version: "1.1.0" }),
		});
		expect(again.replaced).toBe(true);
		expect(again.draft.proofs).toHaveLength(0);
	});

	test("a proof of a different document is refused, not silently recorded", () => {
		const dataRoot = root();
		// The version is the *same* on both sides here on purpose: the version rule
		// alone would accept this proof, so the refusal can only come from the
		// digest (`TQV-203`, `MIG-008`).
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document({ title: "read a customer's address (adjusted)" }),
		});
		const refused = prove(dataRoot, "run-1", document());
		expect(refused.draft).toBeUndefined();
		expect(refused.issue).toContain(
			"with a different body than the one that ran",
		);
	});

	test("a reused workflow id does not adopt a previous run's drafts", () => {
		const dataRoot = root();
		// A workflow id is reusable, so the id alone cannot tell one run from a
		// deleted predecessor's. The run identity is recorded with the draft and
		// checked on read: the older run's document and its passed proof never
		// look like the current run's own work (`CONC-103`).
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			runId: "started-at-1",
			stage: "crm-int",
			document: document(),
		});
		prove(dataRoot, "run-1", document());
		const mine = readStageBlockDrafts(dataRoot, "run-1", "started-at-1");
		expect(mine.drafts.map((draft) => draft.document.id)).toEqual([
			"crm.customer.readAddress",
		]);
		expect(mine.drafts[0]?.draft.proofs).toHaveLength(1);
		// The next run under the same id sees nothing, and nothing to complain
		// about: a predecessor's leftover is not a broken document of this run.
		const next = readStageBlockDrafts(dataRoot, "run-1", "started-at-2");
		expect(next.drafts).toEqual([]);
		expect(next.diagnostics).toEqual([]);
	});

	test("a damaged draft file is a diagnostic, never a fatal read", () => {
		const dataRoot = root();
		const saved = saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		const directory = path.dirname(saved.file);
		// Unparseable JSON, a wrapper written by another format version and one
		// file over the read bound: the healthy draft still loads.
		fs.writeFileSync(path.join(directory, "broken.json"), "{not json");
		fs.writeFileSync(
			path.join(directory, "future.json"),
			JSON.stringify({
				draft: { version: 99, workflowId: "run-1" },
				document: document({ id: "crm.customer.future" }),
			}),
		);
		fs.writeFileSync(
			path.join(directory, "huge.json"),
			JSON.stringify({ padding: "x".repeat(DATA_BLOCK_MAX_BYTES * 2 + 1) }),
		);
		const read = readStageBlockDrafts(dataRoot, "run-1");
		expect(read.drafts.map((draft) => draft.document.id)).toEqual([
			document().id,
		]);
		expect(
			read.diagnostics.map((diagnostic) => diagnostic.code).sort(),
		).toEqual([
			"block-file-unreadable",
			"block-file-unreadable",
			"block-store-version",
		]);
	});

	test("one block id in two system directories is a duplicate, not a coin flip", () => {
		const configDir = root();
		const first = path.join(
			configDir,
			"stages",
			"blocks",
			"crm",
			`${document().id}.json`,
		);
		const second = path.join(
			configDir,
			"stages",
			"blocks",
			"other",
			`${document().id}.json`,
		);
		for (const file of [first, second]) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify(document()));
		}
		const read = readApprovedBlocks(configDir);
		expect(read.blocks).toHaveLength(1);
		expect(read.blocks[0]?.file).toBe(first);
		expect(read.diagnostics).toEqual([
			expect.objectContaining({
				code: "block-duplicate",
				id: document().id,
				file: second,
			}),
		]);
	});

	test("promotion writes the approved file, removes the drafts and keeps both readable", () => {
		const dataRoot = root();
		const configDir = root();
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		prove(dataRoot, "run-1", document());
		const promoted = promoteStageBlockDrafts({
			configDir,
			dataRoot,
			workflowId: "run-1",
			system: "crm",
			claims: [claimOf(document())],
		});
		expect(promoted.promoted).toEqual(["crm.customer.readAddress@1.0.0"]);
		expect(promoted.removed).toBe(1);
		const approved = readApprovedBlocks(configDir);
		expect(approved.blocks.map((block) => block.document.id)).toEqual([
			"crm.customer.readAddress",
		]);
		expect(readStageBlockDrafts(dataRoot, "run-1").drafts).toEqual([]);
		const file = approved.blocks[0]?.file;
		if (file === undefined) throw new Error("promotion wrote no file");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	test("a breaking change without a major bump leaves no file behind", () => {
		const dataRoot = root();
		const configDir = root();
		// An approved 1.0.0 that returns `street`, then a draft at 1.0.0 that
		// requires `orderId` instead: a breaking contract change at the same major.
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		prove(dataRoot, "run-1", document());
		promoteStageBlockDrafts({
			configDir,
			dataRoot,
			workflowId: "run-1",
			system: "crm",
			claims: [claimOf(document())],
		});
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-2",
			stage: "crm-int",
			document: document({
				returns: {
					type: "object",
					additionalProperties: false,
					properties: { orderId: { type: "string" } },
					required: ["orderId"],
				},
				operations: [
					{
						op: "step",
						label: "read the order",
						operations: [
							{ op: "read", target: { testId: "order" }, into: "orderId" },
							{ op: "expectVisible", target: { testId: "order" } },
						],
					},
				],
			}),
		});
		prove(dataRoot, "run-2", document({ version: "1.0.0" }));
		expect(() =>
			promoteStageBlockDrafts({
				configDir,
				dataRoot,
				workflowId: "run-2",
				system: "crm",
				claims: [claimOf(document())],
			}),
		).toThrow(StageBlockStoreError);
		// The draft is still there, and the approved version still returns `street`.
		expect(readStageBlockDrafts(dataRoot, "run-2").drafts).toHaveLength(1);
		expect(
			readApprovedBlocks(configDir).blocks[0]?.document.returns,
		).toMatchObject({ required: ["street"] });
	});

	test("refuses to shadow a checked-in block or to downgrade a version", () => {
		const dataRoot = root();
		const configDir = root();
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document({ id: "crm.ui.open" }),
		});
		prove(dataRoot, "run-1", document({ id: "crm.ui.open" }));
		expect(() =>
			promoteStageBlockDrafts({
				configDir,
				dataRoot,
				workflowId: "run-1",
				system: "crm",
				claims: [claimOf(document({ id: "crm.ui.open" }))],
			}),
		).toThrow(StageBlockStoreError);

		const downgradeRoot = root();
		const downgradeConfig = root();
		saveStageBlockDraft({
			dataRoot: downgradeRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document({ version: "2.0.0" }),
		});
		prove(downgradeRoot, "run-1", document({ version: "2.0.0" }));
		promoteStageBlockDrafts({
			configDir: downgradeConfig,
			dataRoot: downgradeRoot,
			workflowId: "run-1",
			system: "crm",
			claims: [claimOf(document({ version: "2.0.0" }))],
		});
		saveStageBlockDraft({
			dataRoot: downgradeRoot,
			workflowId: "run-2",
			stage: "crm-int",
			document: document({ version: "1.4.0" }),
		});
		prove(downgradeRoot, "run-2", document({ version: "1.4.0" }));
		expect(() =>
			promoteStageBlockDrafts({
				configDir: downgradeConfig,
				dataRoot: downgradeRoot,
				workflowId: "run-2",
				system: "crm",
				claims: [claimOf(document({ version: "1.4.0" }))],
			}),
		).toThrow(/downgrade/);
	});

	test("does nothing for a report that claims no block", () => {
		const dataRoot = root();
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		const promoted = promoteStageBlockDrafts({
			configDir: root(),
			dataRoot,
			workflowId: "run-1",
			system: "crm",
			claims: [],
		});
		expect(promoted).toEqual({ promoted: [], removed: 0 });
		// An unclaimed draft is scratch: it stays in the run store.
		expect(readStageBlockDrafts(dataRoot, "run-1").drafts).toHaveLength(1);
	});

	test("promotes only the drafts the report claims", () => {
		const dataRoot = root();
		const configDir = root();
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		const abandoned = document({
			id: "crm.customer.readOrders",
			title: "Read one customer's orders",
			description: "Opens one customer and reads the order list.",
			postcondition: "the order list is visible",
			returns: {
				type: "object",
				additionalProperties: false,
				properties: {},
				required: [],
			},
			operations: [
				{
					op: "step",
					label: "open the customer",
					operations: [
						{ op: "goto", path: "/customers/{{ args.customerId }}" },
						{ op: "expectVisible", target: { testId: "orders" } },
					],
				},
			],
		});
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: abandoned,
		});
		prove(dataRoot, "run-1", document());
		prove(dataRoot, "run-1", abandoned, "failed");
		const promoted = promoteStageBlockDrafts({
			configDir,
			dataRoot,
			workflowId: "run-1",
			system: "crm",
			claims: [claimOf(document())],
		});
		expect(promoted.promoted).toEqual(["crm.customer.readAddress@1.0.0"]);
		// The draft the developer never saw is not published; the run store is
		// scratch and is emptied once the claimed set landed.
		expect(
			readApprovedBlocks(configDir).blocks.map((b) => b.document.id),
		).toEqual(["crm.customer.readAddress"]);
		expect(readStageBlockDrafts(dataRoot, "run-1").drafts).toEqual([]);
	});

	test("refuses to promote a claimed block without a passed proof", () => {
		const dataRoot = root();
		const configDir = root();
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		prove(dataRoot, "run-1", document(), "failed");
		expect(() =>
			promoteStageBlockDrafts({
				configDir,
				dataRoot,
				workflowId: "run-1",
				system: "crm",
				claims: [claimOf(document())],
			}),
		).toThrow(/no passed execution proof/);
		expect(readApprovedBlocks(configDir).blocks).toEqual([]);
		expect(readStageBlockDrafts(dataRoot, "run-1").drafts).toHaveLength(1);
	});

	test("refuses a claimed block this run no longer holds", () => {
		expect(() =>
			promoteStageBlockDrafts({
				configDir: root(),
				dataRoot: root(),
				workflowId: "run-1",
				system: "crm",
				claims: [claimOf(document())],
			}),
		).toThrow(/holds no draft of it/);
	});

	test("a failed batch restores the document it replaced", () => {
		// One adjustment that is fine, one that breaks its contract at the same
		// major: the batch refuses and the first write has to be undone.
		const adjusted = document({ version: "1.0.1" });
		const breaking = document({
			id: "crm.customer.readOrders",
			title: "Read one customer's orders",
			description: "Opens one customer and reads the order list.",
			postcondition: "the order list is visible",
			version: "1.0.0",
			returns: {
				type: "object",
				additionalProperties: false,
				properties: { orderId: { type: "string" } },
				required: ["orderId"],
			},
			operations: [
				{
					op: "step",
					label: "read the order",
					operations: [
						{ op: "read", target: { testId: "order" }, into: "orderId" },
						{ op: "expectVisible", target: { testId: "order" } },
					],
				},
			],
		});
		// Approve `breaking` at 1.0.0 in its own store first, then make it break at
		// the same major while the batch also carries a valid adjustment.
		const orderRoot = root();
		const orderConfig = root();
		saveStageBlockDraft({
			dataRoot: orderRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: breaking,
		});
		prove(orderRoot, "run-1", breaking);
		promoteStageBlockDrafts({
			configDir: orderConfig,
			dataRoot: orderRoot,
			workflowId: "run-1",
			system: "crm",
			claims: [claimOf(breaking)],
		});
		const breakingAgain = {
			...breaking,
			returns: {
				type: "object",
				additionalProperties: false,
				properties: { settled: { type: "string" } },
				required: ["settled"],
			},
			operations: [
				{
					op: "step",
					label: "read the settlement",
					operations: [
						{ op: "read", target: { testId: "settled" }, into: "settled" },
						{ op: "expectVisible", target: { testId: "settled" } },
					],
				},
			],
		} as StageDataBlockDocument;
		for (const block of [adjusted, breakingAgain]) {
			saveStageBlockDraft({
				dataRoot: orderRoot,
				workflowId: "run-2",
				stage: "crm-int",
				document: block,
			});
			prove(orderRoot, "run-2", block);
		}
		expect(() =>
			promoteStageBlockDrafts({
				configDir: orderConfig,
				dataRoot: orderRoot,
				workflowId: "run-2",
				system: "crm",
				claims: [claimOf(adjusted), claimOf(breakingAgain)],
			}),
		).toThrow(/major version bump/);
		// The adjusted document that was already approved is back, byte for byte.
		const restored = readApprovedBlocks(orderConfig).blocks.find(
			(block) => block.document.id === "crm.customer.readOrders",
		);
		expect(restored?.document.returns).toMatchObject({
			required: ["orderId"],
		});
		expect(readStageBlockDrafts(orderRoot, "run-2").drafts).toHaveLength(2);
	});

	test("a concurrent change to the approved file is refused, not overwritten", () => {
		const configDir = root();
		expect(() =>
			promoteDataBlock({
				configDir,
				system: "crm",
				document: document({ version: "1.0.1" }),
				previous: document(),
			}),
		).toThrow(/changed in the approved store/);
	});

	test("an approved file this build cannot read is refused, not overwritten", () => {
		// A file written by a newer format (or left by a backup or a hand edit) is
		// not an empty slot. The read path tolerates it, so the write path must
		// refuse instead of compare-and-writing over it (`MIG-010`).
		const configDir = root();
		const file = approvedBlockPath(configDir, "crm", document().id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const future = JSON.stringify({ format: 99, id: document().id });
		fs.writeFileSync(file, future);
		expect(readApprovedBlocks(configDir).blocks).toEqual([]);
		expect(() =>
			promoteDataBlock({ configDir, system: "crm", document: document() }),
		).toThrow(/cannot read/);
		expect(fs.readFileSync(file, "utf8")).toBe(future);
		// The same guard covers the batch path an approval takes.
		const dataRoot = root();
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		appendStageBlockProof({
			dataRoot,
			workflowId: "run-1",
			document: document(),
			proof: {
				stage: "crm-int",
				runId: "run-1",
				status: "passed",
				at: "2026-01-02T00:00:00.000Z",
				journalIds: [],
				evidenceIds: [],
			},
		});
		expect(() =>
			promoteStageBlockDrafts({
				configDir,
				dataRoot,
				workflowId: "run-1",
				system: "crm",
				claims: [claimOf(document())],
			}),
		).toThrow(/cannot read/);
		expect(fs.readFileSync(file, "utf8")).toBe(future);
	});

	test("a proof never writes a stale document over a newer draft", () => {
		const dataRoot = root();
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document({ version: "1.1.0" }),
		});
		const appended = appendStageBlockProof({
			dataRoot,
			workflowId: "run-1",
			document: document(),
			proof: {
				stage: "crm-int",
				runId: "run-1",
				status: "passed",
				at: "2026-01-02T00:00:00.000Z",
				journalIds: [],
				evidenceIds: [],
			},
		});
		expect(appended.draft).toBeUndefined();
		expect(appended.issue).toContain("1.1.0");
		const current = readStageBlockDraft(
			dataRoot,
			"run-1",
			"crm.customer.readAddress",
		);
		expect(current?.document.version).toBe("1.1.0");
		expect(current?.draft.proofs).toEqual([]);
	});

	test("a failed re-run does not erase an earlier pass", () => {
		const dataRoot = root();
		saveStageBlockDraft({
			dataRoot,
			workflowId: "run-1",
			stage: "crm-int",
			document: document(),
		});
		prove(dataRoot, "run-1", document());
		prove(dataRoot, "run-1", document(), "failed");
		const proofs = readStageBlockDrafts(dataRoot, "run-1").drafts[0]?.draft
			.proofs;
		expect(proofs?.map((proof) => proof.status)).toEqual(["passed", "failed"]);
	});
});

describe("stage data blocks: the saved flow", () => {
	const flowId = "data-block-customer";
	const stagePlan = {
		ticketSummary: "Read a customer's address",
		knowledgeStatus: "none",
		flowId,
		inputs: { customerId: "C-1001" },
		expectations: [
			{
				id: "E1",
				statement: "The address is visible",
				source: "ticket",
				priority: "high",
			},
		],
		knowledgeUsed: [],
		route: [
			{
				id: "read",
				application: "crm",
				role: "clerk",
				action: "read the address",
				expected: "the street is stored",
				capture: ["street"],
				expectationIds: ["E1"],
				block: {
					id: "crm.customer.readAddress",
					args: { customerId: "{{ inputs.customerId }}" },
				},
			},
		],
		asyncWaits: [],
		createsData: false,
		dataCreated: [],
		notTested: [],
	};

	function harness() {
		const compiled = compileDataBlock(document());
		const registry = createStageBlockRegistry([compiled]);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "data-block-flow-"));
		const projected = blockPlanFromRoute(
			stagePlan.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
			{
				planId: "plan-data",
				flowId,
				revision: 1,
				inputs: { customerId: "C-1001" },
			},
		);
		const validated = validateStageBlockPlan(projected.plan, {
			registry,
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
		return { registry, root, plan: validated.plan };
	}

	// It runs a real generated spec (and formats/type-checks it), so it needs more
	// than the default five seconds on a loaded machine.
	test("writes a sidecar document and a spec that interprets it by runData", async () => {
		const { registry, root, plan } = harness();
		const source = flowSourceFromRoute({
			routePlan: stagePlan,
			plan,
			stage: "crm-int",
			planId: "plan-data",
			revision: 1,
		});
		const generated = await generateFlow({
			root,
			source,
			registry,
			typeCheck: false,
		});
		expect(generated.issues).toEqual([]);
		const spec = generated.spec ?? "";
		expect(spec).toContain('await stage.runData("read", {');
		expect(spec).toContain('stage.input<string>("customerId")');
		expect(spec).toContain("actionTimeout: 15_000");
		// A data block has no barrel export, so the spec imports no block module.
		expect(spec).not.toContain("stage-blocks/blocks/");
		// The reviewed document travels with the flow, byte for byte.
		const sidecar = path.join(
			root,
			"stage-flows",
			flowId,
			"blocks",
			"crm.customer.readAddress.json",
		);
		expect(fs.existsSync(sidecar)).toBe(true);
		expect(JSON.parse(fs.readFileSync(sidecar, "utf8"))).toEqual(document());
		// The manifest pins the sidecar rather than leaving the reader to guess a
		// filename from the block id (`OSV-009`).
		const manifest = JSON.parse(
			fs.readFileSync(
				path.join(root, "stage-flows", flowId, "flow.json"),
				"utf8",
			),
		) as {
			blockFiles?: Record<string, string>;
			blockDigests?: Record<string, string>;
		};
		expect(manifest.blockFiles).toEqual({
			"crm.customer.readAddress": "blocks/crm.customer.readAddress.json",
		});
		// The pinned digest is the document's own, not a placeholder: this is the
		// value a later edit is compared against (`TQV-102`).
		const approved = registry.get("crm.customer.readAddress");
		if (approved === undefined) throw new Error("the block is not registered");
		expect(manifest.blockDigests?.["crm.customer.readAddress"]).toBe(
			blockDigest(approved),
		);
		expect(
			flowEligibility({
				flowId,
				root,
				stage: "crm-int",
				inputs: source.inputs,
				registry,
			}),
		).toEqual({
			eligible: true,
			issues: [],
		});
	}, 30_000);

	test("refuses to replay a draft, and a flow whose document is gone", async () => {
		const { registry, root, plan } = harness();
		const source = flowSourceFromRoute({
			routePlan: stagePlan,
			plan,
			stage: "crm-int",
			planId: "plan-data",
			revision: 1,
		});
		const generated = await generateFlow({
			root,
			source,
			registry,
			typeCheck: false,
		});
		expect(generated.issues).toEqual([]);
		const draft = flowEligibility({
			flowId,
			root,
			stage: "crm-int",
			inputs: source.inputs,
			registry,
			draftIds: new Set(["crm.customer.readAddress"]),
		});
		expect(draft.eligible).toBe(false);
		expect(draft.issues.map((issue) => issue.code)).toContain(
			"flow-block-draft",
		);
		// An approved block whose sidecar was hand-deleted is not replayable either:
		// the flow would otherwise run whatever the live store holds.
		fs.rmSync(
			path.join(
				root,
				"stage-flows",
				flowId,
				"blocks",
				"crm.customer.readAddress.json",
			),
		);
		const missing = flowEligibility({
			flowId,
			root,
			stage: "crm-int",
			inputs: source.inputs,
			registry,
		});
		expect(missing.issues.map((issue) => issue.code)).toContain(
			"flow-block-document-missing",
		);
		// A manifest that names no file for the block is refused too, instead of
		// falling back to a filename the reader would have to invent.
		const manifestFile = path.join(root, "stage-flows", flowId, "flow.json");
		const manifest = JSON.parse(
			fs.readFileSync(manifestFile, "utf8"),
		) as Record<string, unknown>;
		delete manifest.blockFiles;
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		const unpinned = flowEligibility({
			flowId,
			root,
			stage: "crm-int",
			inputs: source.inputs,
			registry,
		});
		expect(unpinned.issues.map((issue) => issue.code)).toContain(
			"flow-block-document-missing",
		);
	}, 30_000);

	test("a sidecar edited after the flow was saved makes it ineligible", async () => {
		const { registry, root, plan } = harness();
		const source = flowSourceFromRoute({
			routePlan: stagePlan,
			plan,
			stage: "crm-int",
			planId: "plan-data",
			revision: 1,
		});
		const generated = await generateFlow({
			root,
			source,
			registry,
			typeCheck: false,
		});
		expect(generated.issues).toEqual([]);
		const sidecar = path.join(
			root,
			"stage-flows",
			flowId,
			"blocks",
			"crm.customer.readAddress.json",
		);
		// A still-valid document with one reworded line is a different document:
		// the flow pinned the bytes it was saved with, so it is not eligible any
		// more (`TQV-102`). The live registry document is unchanged, which is what
		// makes comparing against it instead of the pinned digest detectable here.
		// Read it once while it is intact, so the eligibility memo is warm and the
		// re-read below has to notice the change rather than replay a verdict
		// (`PERF-202`).
		expect(
			flowEligibility({
				flowId,
				root,
				stage: "crm-int",
				inputs: source.inputs,
				registry,
			}).eligible,
		).toBe(true);
		const reworded = { ...document(), postcondition: "the street is returned" };
		fs.writeFileSync(sidecar, JSON.stringify(reworded));
		const drifted = flowEligibility({
			flowId,
			root,
			stage: "crm-int",
			inputs: source.inputs,
			registry,
		});
		expect(drifted.eligible).toBe(false);
		expect(
			drifted.issues.filter((issue) => issue.code === "flow-block-digest"),
		).toEqual([
			{
				code: "flow-block-digest",
				message: `flow ${flowId} stores a different source digest for crm.customer.readAddress@1.0.0`,
				field: "read",
			},
		]);
		// A document that parses but does not validate is reported with the
		// validation issue, so it is distinguishable from a missing file.
		fs.writeFileSync(sidecar, JSON.stringify({ format: 1 }));
		const invalid = flowEligibility({
			flowId,
			root,
			stage: "crm-int",
			inputs: source.inputs,
			registry,
		});
		const invalidIssue = invalid.issues.find(
			(issue) => issue.code === "flow-block-digest",
		);
		expect(invalidIssue?.message).toStartWith(
			`flow ${flowId} stores an invalid document for crm.customer.readAddress: `,
		);
		// Bytes that are not JSON at all are an unreadable file, not a digest
		// mismatch: the reader never has a document to hash.
		fs.writeFileSync(sidecar, "{not json");
		expect(
			flowEligibility({
				flowId,
				root,
				stage: "crm-int",
				inputs: source.inputs,
				registry,
			}).issues.map((issue) => issue.code),
		).toContain("flow-block-document-missing");
	}, 30_000);

	test("the replay's own sidecar seam resolves exactly the pinned document", async () => {
		const { registry, root, plan } = harness();
		const source = flowSourceFromRoute({
			routePlan: stagePlan,
			plan,
			stage: "crm-int",
			planId: "plan-data",
			revision: 1,
		});
		const generated = await generateFlow({
			root,
			source,
			registry,
			typeCheck: false,
		});
		expect(generated.issues).toEqual([]);
		const directory = path.join(root, "stage-flows", flowId);
		const manifest = parseFlowManifest(
			JSON.parse(fs.readFileSync(path.join(directory, "flow.json"), "utf8")),
		).manifest;
		if (manifest === undefined) throw new Error("the flow has no manifest");
		// (a) The sidecar a replay loads is the document the manifest pinned.
		const pinned = pinnedDataBlock({
			manifest,
			directory,
			routeStepId: "read",
		});
		expect(blockDigest(pinned)).toBe(
			manifest.blockDigests["crm.customer.readAddress"],
		);
		// (b) An edited sidecar is refused, naming the route step it was pinned at,
		// rather than silently running the edited document.
		const sidecar = path.join(
			directory,
			"blocks",
			"crm.customer.readAddress.json",
		);
		fs.writeFileSync(
			sidecar,
			JSON.stringify({
				...document(),
				postcondition: "the street is returned",
			}),
		);
		expect(() =>
			pinnedDataBlock({ manifest, directory, routeStepId: "read" }),
		).toThrow(
			`data block crm.customer.readAddress@1.0.0 no longer matches the digest flow ${flowId} pinned at read`,
		);
		// (d) A deleted sidecar names the file it looked for.
		fs.rmSync(sidecar);
		expect(() =>
			pinnedDataBlock({ manifest, directory, routeStepId: "read" }),
		).toThrow(
			`data block crm.customer.readAddress has no sidecar at ${sidecar}`,
		);
		// (c) A manifest that names no file for the block is refused, instead of
		// inventing a filename from the block id.
		fs.writeFileSync(sidecar, JSON.stringify(document()));
		const { blockFiles: _omitted, ...withoutFiles } = manifest;
		expect(() =>
			pinnedDataBlock({
				manifest: withoutFiles as typeof manifest,
				directory,
				routeStepId: "read",
			}),
		).toThrow(
			`flow ${flowId} records no reviewed document for crm.customer.readAddress`,
		);
		// A route step the manifest does not have is its own refusal, not a lookup
		// that silently resolves to nothing.
		expect(() =>
			pinnedDataBlock({ manifest, directory, routeStepId: "gone" }),
		).toThrow("route step gone is not in the manifest");
	}, 30_000);
});

describe("stage data blocks: the route projection", () => {
	const route = (overrides: Record<string, unknown> = {}) => [
		{
			id: "read",
			application: "crm",
			role: "clerk",
			action: "read the address",
			expected: "the street is stored",
			capture: [],
			expectationIds: ["E1"],
			blockToCreate: {
				id: "crm.customer.readAddress",
				args: { customerId: "{{ inputs.customerId }}" },
				intent: "read the stored address of one customer",
			},
			...overrides,
		},
	];

	test("an authored block that is not saved yet is a gap, not an unknown block", () => {
		const registry = createStageBlockRegistry([]);
		const before = blockPlanFromRoute(
			route() as unknown as Parameters<typeof blockPlanFromRoute>[0],
			{ inputs: { customerId: "C-1001" }, registry },
		);
		expect(before.plan.steps).toEqual([]);
		expect(before.missing).toEqual(["read"]);
		const after = blockPlanFromRoute(
			route() as unknown as Parameters<typeof blockPlanFromRoute>[0],
			{
				inputs: { customerId: "C-1001" },
				registry: createStageBlockRegistry([compileDataBlock(document())]),
			},
		);
		expect(after.missing).toEqual([]);
		expect(after.plan.steps[0]).toMatchObject({
			id: "read",
			block: "crm.customer.readAddress",
			args: { customerId: "{{ inputs.customerId }}" },
		});
	});

	test("an adjustment and a stated no-block reason", () => {
		const registry = createStageBlockRegistry([compileDataBlock(document())]);
		const adjust = blockPlanFromRoute(
			route({
				blockToCreate: undefined,
				blockToAdjust: {
					id: "crm.customer.readAddress",
					args: { customerId: "{{ inputs.customerId }}" },
					reason: "the stored street is not read",
				},
			}) as unknown as Parameters<typeof blockPlanFromRoute>[0],
			{ registry },
		);
		expect(adjust.plan.steps[0]?.block).toBe("crm.customer.readAddress");
		const stated = blockPlanFromRoute(
			route({
				blockToCreate: undefined,
				noBlockReason: "the value only a human can decide",
			}) as unknown as Parameters<typeof blockPlanFromRoute>[0],
			{ registry },
		);
		expect(stated.plan.steps).toEqual([]);
		expect(stated.missing).toEqual(["read"]);
	});
});
