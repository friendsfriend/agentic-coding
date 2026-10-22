// The reviewed unit between a stage plan and a browser.
//
// A block owns the mechanics of one user intention. The plan owns the chain,
// inputs and approval. The runner owns the browser, journal and evidence. This
// module is intentionally plain TypeScript: blocks are ordinary functions, not
// an Effect service, and the same function runs under `stage_run` and under the
// generated Playwright fixture.

import type { StageDataBlockDocument } from "./data-block.ts";
import type { JsonSchema, JsonValue } from "./schema.ts";
import {
	canonicalHash,
	sampleValue,
	validateSchemaDefinition,
	validateSchemaValue,
} from "./schema.ts";

export type BlockEffect = "read" | "write" | "destructive";

/** The run facts a block may show in a journal entry. Values are plain text and
 * pass through the server's redactor before they land in the file. */
export interface BlockStepDetails {
	readonly expected?: string;
	readonly observed?: string;
	readonly captures?: Readonly<Record<string, string>>;
	readonly knowledge?: {
		readonly concept: string;
		readonly section?: string;
		readonly kind: "confirmed" | "contradicted" | "missing" | "new";
		readonly suspectedCause?: "product-change" | "regression" | "unknown";
	};
}

export interface BlockStepEvent extends BlockStepDetails {
	readonly label: string;
	readonly status: "passed" | "failed";
	readonly durationMs: number;
	readonly error?: string;
	readonly evidence: readonly string[];
}

/** The allow-listed locator surface shared by the server session adapter and
 * the Playwright fixture. No raw Playwright handle crosses this boundary. */
export interface BlockLocator {
	click(): Promise<void>;
	fill(value: string): Promise<void>;
	/** Types into an already-focused field key by key; `delayMs` is bounded. */
	type(
		value: string,
		options?: {
			readonly delayMs?: number;
		},
	): Promise<void>;
	press(key: string): Promise<void>;
	selectOption(values: string | readonly string[]): Promise<void>;
	textContent(): Promise<string | null>;
	innerText(): Promise<string>;
	isVisible(): Promise<boolean>;
	waitFor(options?: {
		state?: "visible" | "hidden" | "attached";
	}): Promise<void>;
}

export interface BlockAssertion {
	toContainText(expected: string): Promise<void>;
	toBeVisible(): Promise<void>;
}

export interface BlockPage {
	goto(url: string): Promise<void>;
	url(): string;
	title(): Promise<string>;
	getByRole(
		role: string,
		options?: { name?: string; exact?: boolean },
	): BlockLocator;
	getByLabel(label: string): BlockLocator;
	getByTestId(testId: string): BlockLocator;
	getByText(text: string, options?: { exact?: boolean }): BlockLocator;
	locator(selector: string): BlockLocator;
	reload(): Promise<void>;
	waitForTimeout(ms: number): Promise<void>;
}

export interface StageApiResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: JsonValue;
}

/** The policy-checked API surface of a stage application (`D6`). */
export interface StageApiClient {
	request(input: {
		readonly app: string;
		readonly role: string;
		readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		readonly path: string;
		readonly body?: JsonValue;
	}): Promise<StageApiResponse>;
}

export interface BlockRunMetadata {
	readonly planId: string;
	readonly revision?: number;
	readonly flowId?: string;
	readonly routeStepId: string;
	readonly blockId: string;
	readonly blockVersion: string;
	readonly index: number;
}

export interface StageContext {
	readonly page: BlockPage;
	readonly expect: (locator: BlockLocator) => BlockAssertion;
	readonly app: string;
	readonly role?: string;
	readonly stage: string;
	/** The base URL of the application the block should navigate within. */
	readonly appUrl: string;
	readonly run: BlockRunMetadata;
	readonly api?: StageApiClient;
	/** Executes one journalled sub-step. A block must emit at least one. */
	step<T>(
		label: string,
		fn: () => Promise<T>,
		details?: BlockStepDetails | (() => BlockStepDetails),
	): Promise<T>;
	/** Stores a screenshot (or another bounded capture) and returns its evidence
	 * id. The runner attributes it to the current sub-step. */
	capture(
		label: string,
		options?: { readonly ref?: string; readonly view?: boolean },
	): Promise<string>;
	/** Resolves one `.env` value by name; never accepts a literal secret. */
	secret(name: string): string;
}

export interface BlockDeprecation {
	readonly replacementId?: string;
	readonly removalDate?: string;
}

export interface BlockDefinition<
	Args extends Record<string, JsonValue> = Record<string, JsonValue>,
	Outputs extends Record<string, JsonValue> = Record<string, JsonValue>,
> {
	readonly id: string;
	readonly version: string;
	/** The stage application key, or `*` for a cross-application block. */
	readonly app: string;
	/** An empty list means every role of the application. */
	readonly roles?: readonly string[];
	readonly title: string;
	readonly description: string;
	/** The export a generated spec imports from the application's block barrel. */
	readonly exportName?: string;
	readonly params: JsonSchema;
	readonly returns: JsonSchema;
	readonly effects: readonly BlockEffect[];
	readonly idempotent: boolean;
	readonly requires?: readonly string[];
	readonly provides?: readonly string[];
	readonly examples: readonly Args[];
	/** The repository test that proves a checked-in block against its
	 * application. A data block proves itself with validated examples and the
	 * recorded live proof on its draft instead, so it has none. */
	readonly contractTest?: string;
	/** Present only for a block authored as reviewed JSON; `run` then interprets
	 * this document. It is the executable body the digest covers. */
	readonly data?: StageDataBlockDocument;
	readonly internal?: boolean;
	readonly deprecated?: BlockDeprecation;
	readonly run: (ctx: StageContext, args: Args) => Promise<Outputs>;
}

export interface BlockMetadata {
	readonly id: string;
	readonly version: string;
	readonly app: string;
	readonly roles: readonly string[];
	readonly title: string;
	readonly description: string;
	/** The export a generated spec imports from the application's block barrel. */
	readonly exportName?: string;
	readonly params: JsonSchema;
	readonly returns: JsonSchema;
	readonly effects: readonly BlockEffect[];
	readonly idempotent: boolean;
	readonly requires: readonly string[];
	readonly provides: readonly string[];
	readonly examples: readonly Record<string, JsonValue>[];
	readonly contractTest?: string;
	/** `checked-in` is a TypeScript module; `data` is a reviewed JSON document. */
	readonly kind: "checked-in" | "data";
	/** The state a live run proves; data blocks have no contract test. */
	readonly postcondition?: string;
	/** Present only for a data block: the reviewed document it executes. */
	readonly data?: StageDataBlockDocument;
	/** A draft is visible to its own workflow only and is promoted on review. */
	readonly status?: "draft";
	readonly internal: boolean;
	readonly deprecated?: BlockDeprecation;
	readonly digest: string;
}

export class StageBlockDefinitionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StageBlockDefinitionError";
	}
}

const ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const APP_PATTERN = /^(?:\*|[a-z][a-z0-9-]*)$/;
const STATE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateMetadata(
	value: Omit<BlockDefinition, "run">,
): asserts value is Omit<BlockDefinition, "run"> {
	const fail = (code: string, message: string): never => {
		throw new StageBlockDefinitionError(code, message);
	};
	if (!ID_PATTERN.test(value.id))
		fail("block-id", `block id ${value.id} must look like app.intentName`);
	if (!VERSION_PATTERN.test(value.version))
		fail("block-version", `block ${value.id} version must be semver`);
	if (!APP_PATTERN.test(value.app))
		fail("block-app", `block ${value.id} app scope ${value.app} is invalid`);
	for (const role of value.roles ?? []) {
		if (typeof role !== "string" || role.trim() === "")
			fail("block-role", `block ${value.id} has an empty role`);
	}
	if (value.title.trim() === "")
		fail("block-title", `block ${value.id} needs a title`);
	if (value.title.length > 160)
		fail(
			"block-title",
			`block ${value.id} title is longer than 160 characters`,
		);
	if (value.description.trim() === "")
		fail("block-description", `block ${value.id} needs a description`);
	if (value.description.length > 2_000)
		fail(
			"block-description",
			`block ${value.id} description is longer than 2000 characters`,
		);
	if (
		value.exportName !== undefined &&
		!/^[a-z][A-Za-z0-9]*$/.test(value.exportName)
	)
		fail(
			"block-export-name",
			`block ${value.id} exportName must start with a lower-case letter and contain only letters or digits`,
		);
	for (const [name, schema] of [
		["params", value.params],
		["returns", value.returns],
	] as const) {
		const issues = validateSchemaDefinition(schema, `${value.id}.${name}`);
		if (issues.length > 0)
			fail(
				"block-schema",
				`block ${value.id} ${name}: ${issues
					.map((issue) => `${issue.path} ${issue.message}`)
					.join("; ")}`,
			);
		if ("anyOf" in schema || schema.type !== "object")
			throw new StageBlockDefinitionError(
				"block-schema",
				`block ${value.id} ${name} must be an object schema`,
			);
		if (schema.additionalProperties !== false)
			throw new StageBlockDefinitionError(
				"block-schema",
				`block ${value.id} ${name} must set additionalProperties: false`,
			);
	}
	if (value.effects.length === 0)
		fail("block-effects", `block ${value.id} needs at least one effect`);
	if (new Set(value.effects).size !== value.effects.length)
		fail("block-effects", `block ${value.id} repeats an effect`);
	for (const effect of value.effects) {
		if (effect !== "read" && effect !== "write" && effect !== "destructive")
			fail("block-effects", `block ${value.id} has unknown effect ${effect}`);
	}
	if (typeof value.idempotent !== "boolean")
		fail("block-idempotency", `block ${value.id} needs an idempotency flag`);
	for (const [name, entries] of [
		["requires", value.requires ?? []],
		["provides", value.provides ?? []],
	] as const) {
		if (new Set(entries).size !== entries.length)
			fail("block-state", `block ${value.id} repeats a ${name} state`);
		for (const entry of entries)
			if (!STATE_PATTERN.test(entry))
				fail(
					"block-state",
					`block ${value.id} ${name} state ${entry} is invalid`,
				);
	}
	if (value.examples.length === 0)
		fail("block-examples", `block ${value.id} needs at least one example`);
	value.examples.forEach((example, index) => {
		const issues = validateSchemaValue(
			value.params,
			example,
			`${value.id}.examples[${index}]`,
		);
		if (issues.length > 0)
			fail(
				"block-example",
				`block ${value.id} example ${index}: ${issues
					.map((issue) => `${issue.path} ${issue.message}`)
					.join("; ")}`,
			);
	});
	if (value.contractTest !== undefined && value.contractTest.trim() === "")
		fail(
			"block-contract-test",
			`block ${value.id} contract test path is empty`,
		);
	if (value.data === undefined) {
		if (value.contractTest === undefined)
			fail(
				"block-contract-test",
				`block ${value.id} needs a contract test path ending in .ts`,
			);
		else if (!value.contractTest.endsWith(".ts"))
			fail(
				"block-contract-test",
				`block ${value.id} needs a contract test path ending in .ts`,
			);
	} else if (value.exportName !== undefined)
		fail(
			"block-export-name",
			`data block ${value.id} is interpreted, so it has no barrel export`,
		);
	if (value.deprecated?.replacementId !== undefined) {
		if (!ID_PATTERN.test(value.deprecated.replacementId))
			fail("block-deprecation", `block ${value.id} replacement id is invalid`);
		if (value.deprecated.replacementId === value.id)
			fail("block-deprecation", `block ${value.id} cannot replace itself`);
	}
	if (
		value.deprecated?.removalDate !== undefined &&
		!DATE_PATTERN.test(value.deprecated.removalDate)
	)
		fail(
			"block-deprecation",
			`block ${value.id} removal date is not YYYY-MM-DD`,
		);
	if (
		value.deprecated !== undefined &&
		value.deprecated.replacementId === undefined &&
		value.deprecated.removalDate === undefined
	)
		fail(
			"block-deprecation",
			`block ${value.id} deprecation needs a replacement or a removal date`,
		);
}

/** Validate and freeze one block definition. Freezing catches accidental
 * mutation of a shared registry entry at runtime. */
export function defineBlock<
	Args extends Record<string, JsonValue>,
	Outputs extends Record<string, JsonValue>,
>(definition: BlockDefinition<Args, Outputs>): BlockDefinition<Args, Outputs> {
	validateMetadata(definition);
	return Object.freeze({
		...definition,
		effects: Object.freeze([...definition.effects]),
		roles: Object.freeze([...(definition.roles ?? [])]),
		requires: Object.freeze([...(definition.requires ?? [])]),
		provides: Object.freeze([...(definition.provides ?? [])]),
		examples: Object.freeze(
			definition.examples.map((example) => Object.freeze({ ...example })),
		),
	});
}

/** A digest over the public contract and the executable source. A version bump
 * is a promise; the digest checks that the promise was kept. */
export function blockDigest(definition: BlockDefinition): string {
	return canonicalHash({
		id: definition.id,
		version: definition.version,
		app: definition.app,
		roles: definition.roles ?? [],
		title: definition.title,
		description: definition.description,
		exportName: definition.exportName ?? null,
		params: definition.params,
		returns: definition.returns,
		effects: definition.effects,
		idempotent: definition.idempotent,
		requires: definition.requires ?? [],
		provides: definition.provides ?? [],
		contractTest: definition.contractTest ?? null,
		deprecated: definition.deprecated ?? null,
		// A data block has no function source; the reviewed document is its body,
		// so the digest pins exactly what a run executes.
		source:
			definition.data === undefined
				? definition.run.toString()
				: canonicalHash(definition.data),
	});
}

/** The manifest/catalog projection of one block. It carries no function source
 * and no secret: `digest` is the only executable identity a planner sees.
 *
 * `digest` is a parameter because hashing a data block means canonicalising its
 * whole reviewed document: a caller that needs both the projection and the
 * digest (the registry does) computes it once and passes it in, instead of
 * serialising and hashing the same 64 KiB twice per registry build
 * (`PERF-201`). */
export function blockMetadata(
	definition: BlockDefinition,
	digest = blockDigest(definition),
): BlockMetadata {
	return Object.freeze({
		id: definition.id,
		version: definition.version,
		app: definition.app,
		roles: Object.freeze([...(definition.roles ?? [])]),
		title: definition.title,
		description: definition.description,
		...(definition.exportName === undefined
			? {}
			: { exportName: definition.exportName }),
		params: definition.params,
		returns: definition.returns,
		effects: Object.freeze([...definition.effects]),
		idempotent: definition.idempotent,
		requires: Object.freeze([...(definition.requires ?? [])]),
		provides: Object.freeze([...(definition.provides ?? [])]),
		examples: Object.freeze(
			definition.examples.map((example) => Object.freeze({ ...example })),
		),
		...(definition.contractTest === undefined
			? {}
			: { contractTest: definition.contractTest }),
		kind: definition.data === undefined ? "checked-in" : "data",
		...(definition.data === undefined
			? {}
			: {
					data: definition.data,
					postcondition: definition.data.postcondition,
				}),
		internal: definition.internal === true,
		...(definition.deprecated === undefined
			? {}
			: { deprecated: Object.freeze({ ...definition.deprecated }) }),
		digest,
	});
}

/** Definition-time check for a breaking change against a previous contract.
 * A changed parameter/return schema, application scope, effects or required
 * state is breaking and needs a major version bump. */
export function breakingContractChanges(
	previous: BlockDefinition,
	next: BlockDefinition,
): string[] {
	const changes: string[] = [];
	if (previous.id !== next.id) return ["id"];
	if (canonicalHash(previous.params) !== canonicalHash(next.params))
		changes.push("params");
	if (canonicalHash(previous.returns) !== canonicalHash(next.returns))
		changes.push("returns");
	if (previous.app !== next.app) changes.push("app");
	if (canonicalHash(previous.roles ?? []) !== canonicalHash(next.roles ?? []))
		changes.push("roles");
	if (canonicalHash(previous.effects) !== canonicalHash(next.effects))
		changes.push("effects");
	if (
		canonicalHash(previous.requires ?? []) !==
		canonicalHash(next.requires ?? [])
	)
		changes.push("requires");
	if (
		canonicalHash(previous.provides ?? []) !==
		canonicalHash(next.provides ?? [])
	)
		changes.push("provides");
	return changes;
}

/** True when two versions differ only in their major component. This is the
 * version bump rule the registry applies to a breaking contract change. */
export function hasMajorBump(previous: string, next: string): boolean {
	const [previousMajor] = previous.split(".");
	const [nextMajor] = next.split(".");
	return Number(nextMajor) > Number(previousMajor);
}

/** The stable examples a catalog exposes. Examples are validated at definition
 * time, so this projection only strips the readonly wrapper. */
export function exampleValues(definition: BlockDefinition): JsonValue[] {
	return definition.examples.map((example) => ({ ...example }));
}

/** A sample argument object for a dry run, never executed. */
export function sampleArguments(
	definition: BlockDefinition,
): Record<string, JsonValue> {
	const sample = sampleValue(definition.params);
	return sample !== null && typeof sample === "object" && !Array.isArray(sample)
		? (sample as Record<string, JsonValue>)
		: {};
}
