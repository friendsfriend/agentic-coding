// Data blocks: the browser mechanics of one intention, authored as reviewed
// JSON by the stage-tester instead of as a TypeScript module. A document is
// validated here, interpreted against the same `StageContext` a checked-in
// block receives, and compiled to the same frozen `BlockDefinition`, so the
// runner, plan, catalog, flow and replay layers never learn a second shape.
//
// The surface is deliberately closed: a fixed operation set, a fixed locator
// set, `{{ args.<name> }}` interpolation and nothing else. No expression, no
// script, no raw URL, no credential literal.
//
// Nesting is bounded structurally rather than by a counter: a top-level list
// holds `step`/`optional` groups only, and a group body is an action list that
// cannot contain another group. A document is therefore at most two levels
// deep, which satisfies the format's "nesting depth ≤ 3" without a depth
// parameter no code path could ever reach (`QUALITY-004`).

import type {
	BlockEffect,
	BlockLocator,
	BlockPage,
	BlockStepDetails,
	StageContext,
} from "./define-block.ts";
import { defineBlock } from "./define-block.ts";
import type { JsonSchema, JsonValue, ObjectSchema } from "./schema.ts";
import { validateSchemaDefinition, validateSchemaValue } from "./schema.ts";

export const DATA_BLOCK_FORMAT = 1 as const;
export const DATA_BLOCK_MAX_BYTES = 64 * 1024;
export const DATA_BLOCK_MAX_OPERATIONS = 64;
export const DATA_BLOCK_MAX_TEXT = 2_000;
export const DATA_BLOCK_MAX_LABEL = 200;
export const DATA_BLOCK_MAX_SELECTOR = 500;
export const DATA_BLOCK_MAX_DELAY_MS = 1_000;
/** `type` types key by key; the default pace matches a person, which is also what
 * a UI that reacts to typing needs (`OSV-011`). */
export const DATA_BLOCK_DEFAULT_DELAY_MS = 50;
export const DATA_BLOCK_MAX_WAIT_MS = 10_000;

const ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const APP_PATTERN = /^(?:\*|[a-z][a-z0-9-]*)$/;
const STATE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ARGUMENT_REFERENCE = /\{\{\s*args\.([A-Za-z0-9_-]+)\s*\}\}/g;

/** Exactly one locator strategy. The validator refuses a target that names two
 * or none, so the interpreter never guesses. */
export interface DataBlockTarget {
	readonly role?: string;
	readonly name?: string;
	readonly exact?: boolean;
	readonly label?: string;
	readonly testId?: string;
	readonly text?: string;
	readonly selector?: string;
}

export type DataBlockValue = string | { readonly secret: string };

export interface DataBlockKnowledge {
	readonly concept: string;
	readonly section?: string;
	readonly kind: "confirmed" | "contradicted" | "missing" | "new";
	readonly suspectedCause?: "product-change" | "regression" | "unknown";
}

export type DataBlockAction =
	| { readonly op: "goto"; readonly path: string }
	| { readonly op: "click"; readonly target: DataBlockTarget }
	| {
			readonly op: "fill";
			readonly target: DataBlockTarget;
			readonly value: DataBlockValue;
	  }
	| {
			readonly op: "type";
			readonly target: DataBlockTarget;
			readonly value: DataBlockValue;
			readonly delayMs?: number;
	  }
	| {
			readonly op: "press";
			readonly target: DataBlockTarget;
			readonly key: string;
	  }
	| {
			readonly op: "select";
			readonly target: DataBlockTarget;
			readonly values: readonly DataBlockValue[];
	  }
	| {
			readonly op: "waitFor";
			readonly target: DataBlockTarget;
			readonly state?: "visible" | "hidden" | "attached";
	  }
	| { readonly op: "wait"; readonly ms: number }
	| { readonly op: "expectVisible"; readonly target: DataBlockTarget }
	| {
			readonly op: "expectText";
			readonly target: DataBlockTarget;
			readonly text: string;
	  }
	| { readonly op: "capture"; readonly label: string }
	| {
			readonly op: "read";
			readonly target: DataBlockTarget;
			readonly into: string;
			readonly trim?: boolean;
	  };

export interface DataBlockStep {
	readonly op: "step";
	readonly label: string;
	readonly expected?: string;
	readonly observed?: string;
	readonly captures?: Readonly<Record<string, string>>;
	readonly knowledge?: DataBlockKnowledge;
	readonly operations: readonly DataBlockAction[];
}

/** An operation group whose failure is recorded in its own journal entry and
 * swallowed: a cleanup or an optional affordance never fails the block. */
export interface DataBlockOptional {
	readonly op: "optional";
	readonly reason: string;
	readonly operations: readonly DataBlockAction[];
}

export type StageDataBlockOperation = DataBlockStep | DataBlockOptional;

export interface StageDataBlockDocument {
	readonly format: typeof DATA_BLOCK_FORMAT;
	readonly id: string;
	readonly version: string;
	readonly app: string;
	readonly roles?: readonly string[];
	readonly title: string;
	readonly description: string;
	readonly effects: readonly BlockEffect[];
	readonly idempotent: boolean;
	readonly requires?: readonly string[];
	readonly provides?: readonly string[];
	readonly params: JsonSchema;
	readonly returns: JsonSchema;
	readonly examples: readonly Record<string, JsonValue>[];
	readonly postcondition: string;
	readonly operations: readonly StageDataBlockOperation[];
}

export interface DataBlockIssue {
	readonly path: string;
	readonly code: string;
	readonly message: string;
}

export interface DataBlockValidation {
	readonly ok: boolean;
	readonly issues: readonly DataBlockIssue[];
	readonly document?: StageDataBlockDocument;
}

export class StageDataBlockError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StageDataBlockError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function quoted(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

class Issues {
	readonly items: DataBlockIssue[] = [];

	add(path: string, code: string, message: string): void {
		this.items.push({ path, code, message });
	}

	text(
		value: unknown,
		path: string,
		code: string,
		max: number,
		required = true,
	): string | undefined {
		if (value === undefined) {
			if (required) this.add(path, code, "value is required");
			return undefined;
		}
		if (typeof value !== "string") {
			this.add(path, code, "expected a string");
			return undefined;
		}
		if (required && value.trim() === "") {
			this.add(path, code, "value is empty");
			return undefined;
		}
		if (value.length > max) {
			this.add(path, code, `value is longer than ${max} characters`);
			return undefined;
		}
		return value;
	}

	onlyKeys(
		value: Record<string, unknown>,
		allowed: readonly string[],
		path: string,
	): void {
		for (const key of Object.keys(value))
			if (!allowed.includes(key))
				this.add(
					`${path}.${key}`,
					"data-block-unknown-field",
					`unknown field ${key}`,
				);
	}

	boolean(value: unknown, path: string, code: string): boolean | undefined {
		if (value === undefined) {
			this.add(path, code, "value is required");
			return undefined;
		}
		if (typeof value !== "boolean") {
			this.add(path, code, "expected a boolean");
			return undefined;
		}
		return value;
	}

	object(value: unknown, path: string): Record<string, unknown> | undefined {
		if (!isRecord(value)) {
			this.add(path, "data-block-shape", "expected an object");
			return undefined;
		}
		return value;
	}

	array(value: unknown, path: string, max: number): unknown[] | undefined {
		if (!Array.isArray(value)) {
			this.add(path, "data-block-shape", "expected an array");
			return undefined;
		}
		if (value.length === 0)
			this.add(path, "data-block-shape", "array is empty");
		if (value.length > max)
			this.add(path, "data-block-shape", `array is longer than ${max} entries`);
		return value;
	}
}

/** The five locator strategies; `name` only qualifies `role` and `exact`
 * qualifies `role` and `text`, so both are keys of a target rather than a
 * second strategy. */
const TARGET_STRATEGIES = [
	"role",
	"label",
	"testId",
	"text",
	"selector",
] as const;

const TARGET_KEYS = [...TARGET_STRATEGIES, "name", "exact"] as const;

const ACTION_KEYS: Readonly<Record<DataBlockAction["op"], readonly string[]>> =
	{
		goto: ["op", "path"],
		click: ["op", "target"],
		fill: ["op", "target", "value"],
		type: ["op", "target", "value", "delayMs"],
		press: ["op", "target", "key"],
		select: ["op", "target", "values"],
		waitFor: ["op", "target", "state"],
		wait: ["op", "ms"],
		expectVisible: ["op", "target"],
		expectText: ["op", "target", "text"],
		capture: ["op", "label"],
		read: ["op", "target", "into", "trim"],
	};

const STEP_KEYS = [
	"op",
	"label",
	"expected",
	"observed",
	"captures",
	"knowledge",
	"operations",
];
const OPTIONAL_KEYS = ["op", "reason", "operations"];
const DOCUMENT_KEYS = [
	"format",
	"id",
	"version",
	"app",
	"roles",
	"title",
	"description",
	"effects",
	"idempotent",
	"requires",
	"provides",
	"params",
	"returns",
	"examples",
	"postcondition",
	"operations",
];

/** The only references a document may carry. Anything else that looks like a
 * placeholder is a refusal, not text passed to the browser. */
function checkReferences(
	value: string,
	args: Issues,
	path: string,
	paramNames: ReadonlySet<string>,
): void {
	for (const match of value.matchAll(ARGUMENT_REFERENCE))
		if (!paramNames.has(match[1] ?? ""))
			args.add(
				path,
				"data-block-unknown-argument",
				`\`${match[0]}\` names an argument the block does not declare`,
			);
	const stripped = value.replace(ARGUMENT_REFERENCE, "");
	if (stripped.includes("{{") || stripped.includes("}}"))
		args.add(
			path,
			"data-block-reference",
			"only `{{ args.<name> }}` placeholders are allowed",
		);
}

function checkTarget(
	value: unknown,
	issues: Issues,
	path: string,
	paramNames: ReadonlySet<string>,
): DataBlockTarget | undefined {
	const record = issues.object(value, path);
	if (!record) return undefined;
	issues.onlyKeys(record, TARGET_KEYS, path);
	const present = TARGET_STRATEGIES.filter((key) => record[key] !== undefined);
	if (present.length !== 1) {
		issues.add(
			path,
			"data-block-target",
			"a target names exactly one locator strategy (role, label, testId, text or selector)",
		);
		return undefined;
	}
	const strategy = present[0];
	if (strategy === undefined) return undefined;
	if (strategy === "role") {
		const role = issues.text(
			record.role,
			`${path}.role`,
			"data-block-target",
			64,
		);
		const name = issues.text(
			record.name,
			`${path}.name`,
			"data-block-target",
			DATA_BLOCK_MAX_LABEL,
			false,
		);
		if (name !== undefined)
			checkReferences(name, issues, `${path}.name`, paramNames);
		const exact =
			record.exact === undefined
				? undefined
				: issues.boolean(record.exact, `${path}.exact`, "data-block-target");
		return {
			...(role === undefined ? {} : { role }),
			...(name === undefined ? {} : { name }),
			...(exact === undefined ? {} : { exact }),
		};
	}
	if (record.exact !== undefined && strategy !== "text") {
		// `exact` only changes how role/text are matched; accepting it for a
		// label, testId or selector would silently do nothing (`QUALITY-006`).
		issues.add(
			`${path}.exact`,
			"data-block-target",
			"exact is only meaningful on a role or text target",
		);
		return undefined;
	}
	const text = issues.text(
		record[strategy],
		`${path}.${strategy}`,
		"data-block-target",
		strategy === "selector" ? DATA_BLOCK_MAX_SELECTOR : DATA_BLOCK_MAX_LABEL,
	);
	if (text !== undefined)
		checkReferences(text, issues, `${path}.${strategy}`, paramNames);
	// `exact` is legal on a text target, so it has to travel with it: dropping it
	// here would validate a flag the locator then never receives and quietly
	// match a substring (`QUALITY-004`).
	const exact =
		strategy === "text"
			? issues.boolean(record.exact, `${path}.exact`, "data-block-target")
			: undefined;
	return {
		[strategy]: record[strategy],
		...(exact === undefined ? {} : { exact }),
	} as DataBlockTarget;
}

function checkValue(
	value: unknown,
	issues: Issues,
	path: string,
	paramNames: ReadonlySet<string>,
): DataBlockValue | undefined {
	if (typeof value === "string") {
		issues.text(value, path, "data-block-value", DATA_BLOCK_MAX_TEXT);
		checkReferences(value, issues, path, paramNames);
		return value;
	}
	const record = issues.object(value, path);
	if (!record) return undefined;
	issues.onlyKeys(record, ["secret"], path);
	const name = issues.text(
		record.secret,
		`${path}.secret`,
		"data-block-value",
		128,
	);
	if (name !== undefined && !SECRET_NAME_PATTERN.test(name))
		issues.add(
			`${path}.secret`,
			"data-block-value",
			"a secret is named by its environment variable, never its value",
		);
	return name === undefined ? undefined : { secret: name };
}

function checkAction(
	value: unknown,
	issues: Issues,
	path: string,
	paramNames: ReadonlySet<string>,
	returnNames: ReadonlySet<string>,
): DataBlockAction | undefined {
	const record = issues.object(value, path);
	if (!record) return undefined;
	const op = record.op;
	if (typeof op !== "string" || !Object.hasOwn(ACTION_KEYS, op)) {
		issues.add(
			path,
			"data-block-operation",
			`operation must be one of ${Object.keys(ACTION_KEYS).join(", ")}`,
		);
		return undefined;
	}
	issues.onlyKeys(record, ACTION_KEYS[op as DataBlockAction["op"]], path);
	switch (op) {
		case "goto": {
			const target = issues.text(
				record.path,
				`${path}.path`,
				"data-block-path",
				DATA_BLOCK_MAX_SELECTOR,
			);
			if (
				target !== undefined &&
				(!target.startsWith("/") || target.startsWith("//"))
			)
				issues.add(
					`${path}.path`,
					"data-block-path",
					"a goto path is a path inside the application, never a URL",
				);
			if (target !== undefined)
				checkReferences(target, issues, `${path}.path`, paramNames);
			return target === undefined ? undefined : { op: "goto", path: target };
		}
		case "wait": {
			const ms = record.ms;
			if (
				typeof ms !== "number" ||
				!Number.isInteger(ms) ||
				ms < 0 ||
				ms > DATA_BLOCK_MAX_WAIT_MS
			) {
				issues.add(
					`${path}.ms`,
					"data-block-wait",
					`a wait is an integer between 0 and ${DATA_BLOCK_MAX_WAIT_MS} ms`,
				);
				return undefined;
			}
			return { op: "wait", ms };
		}
		case "capture": {
			const label = issues.text(
				record.label,
				`${path}.label`,
				"data-block-capture",
				DATA_BLOCK_MAX_LABEL,
			);
			return label === undefined ? undefined : { op: "capture", label };
		}
		case "read": {
			const target = checkTarget(
				record.target,
				issues,
				`${path}.target`,
				paramNames,
			);
			const into = issues.text(
				record.into,
				`${path}.into`,
				"data-block-read",
				64,
			);
			if (into !== undefined && !returnNames.has(into))
				issues.add(
					`${path}.into`,
					"data-block-read",
					`\`${into}\` is not a declared return value`,
				);
			if (into !== undefined && !/^[a-z][A-Za-z0-9]*$/.test(into))
				issues.add(
					`${path}.into`,
					"data-block-read",
					"a return name starts with a lower-case letter and holds only letters or digits",
				);
			const trim =
				record.trim === undefined
					? undefined
					: issues.boolean(record.trim, `${path}.trim`, "data-block-read");
			if (target === undefined || into === undefined) return undefined;
			return {
				op: "read",
				target,
				into,
				...(trim === undefined ? {} : { trim }),
			};
		}
		default: {
			const target = checkTarget(
				record.target,
				issues,
				`${path}.target`,
				paramNames,
			);
			if (op === "click" || op === "expectVisible")
				return target === undefined ? undefined : { op, target };
			if (op === "press") {
				const key = issues.text(
					record.key,
					`${path}.key`,
					"data-block-key",
					40,
				);
				return target === undefined || key === undefined
					? undefined
					: { op: "press", target, key };
			}
			if (op === "waitFor") {
				const state = record.state;
				if (
					state !== undefined &&
					state !== "visible" &&
					state !== "attached"
				) {
					issues.add(
						`${path}.state`,
						"data-block-wait",
						state === "hidden"
							? "state hidden is not supported by the stage page; wait for the element to disappear with an isVisible expectation on another target, or wait for the visible state of what replaces it"
							: "state must be visible or attached",
					);
					return undefined;
				}
				return target === undefined
					? undefined
					: {
							op: "waitFor",
							target,
							...(state === undefined ? {} : { state }),
						};
			}
			if (op === "expectText") {
				const text = issues.text(
					record.text,
					`${path}.text`,
					"data-block-expectation",
					DATA_BLOCK_MAX_TEXT,
				);
				if (text !== undefined)
					checkReferences(text, issues, `${path}.text`, paramNames);
				return target === undefined || text === undefined
					? undefined
					: { op: "expectText", target, text };
			}
			if (op === "fill") {
				const value = checkValue(
					record.value,
					issues,
					`${path}.value`,
					paramNames,
				);
				return target === undefined || value === undefined
					? undefined
					: { op: "fill", target, value };
			}
			if (op === "type") {
				const value = checkValue(
					record.value,
					issues,
					`${path}.value`,
					paramNames,
				);
				const delayMs = record.delayMs;
				if (
					delayMs !== undefined &&
					(typeof delayMs !== "number" ||
						!Number.isInteger(delayMs) ||
						delayMs < 0 ||
						delayMs > DATA_BLOCK_MAX_DELAY_MS)
				) {
					issues.add(
						`${path}.delayMs`,
						"data-block-delay",
						`a typing delay is an integer between 0 and ${DATA_BLOCK_MAX_DELAY_MS} ms`,
					);
					return undefined;
				}
				if (target === undefined || value === undefined) return undefined;
				return {
					op: "type",
					target,
					value,
					...(typeof delayMs === "number" ? { delayMs } : {}),
				};
			}
			// select
			const values = issues.array(record.values, `${path}.values`, 16);
			const parsed = (values ?? [])
				.map((entry, index) =>
					checkValue(entry, issues, `${path}.values[${index}]`, paramNames),
				)
				.filter((entry): entry is DataBlockValue => entry !== undefined);
			return target === undefined || parsed.length !== (values ?? []).length
				? undefined
				: { op: "select", target, values: parsed };
		}
	}
}

function checkActions(
	value: unknown,
	issues: Issues,
	path: string,
	paramNames: ReadonlySet<string>,
	returnNames: ReadonlySet<string>,
	counter: { count: number; expectations: number },
): readonly DataBlockAction[] | undefined {
	const entries = issues.array(value, path, DATA_BLOCK_MAX_OPERATIONS);
	if (!entries) return undefined;
	const parsed: DataBlockAction[] = [];
	for (const [index, entry] of entries.entries()) {
		counter.count += 1;
		if (counter.count > DATA_BLOCK_MAX_OPERATIONS)
			issues.add(
				path,
				"data-block-operations",
				`a block has at most ${DATA_BLOCK_MAX_OPERATIONS} operations`,
			);
		const action = checkAction(
			entry,
			issues,
			`${path}[${index}]`,
			paramNames,
			returnNames,
		);
		if (!action) continue;
		if (action.op === "expectVisible" || action.op === "expectText")
			counter.expectations += 1;
		parsed.push(action);
	}
	return parsed;
}

function checkKnowledge(
	value: unknown,
	issues: Issues,
	path: string,
): DataBlockKnowledge | undefined {
	const record = issues.object(value, path);
	if (!record) return undefined;
	issues.onlyKeys(
		record,
		["concept", "section", "kind", "suspectedCause"],
		path,
	);
	const concept = issues.text(
		record.concept,
		`${path}.concept`,
		"data-block-knowledge",
		512,
	);
	const section = issues.text(
		record.section,
		`${path}.section`,
		"data-block-knowledge",
		256,
		false,
	);
	const kind = record.kind;
	if (
		kind !== "confirmed" &&
		kind !== "contradicted" &&
		kind !== "missing" &&
		kind !== "new"
	) {
		issues.add(
			`${path}.kind`,
			"data-block-knowledge",
			"kind must be confirmed, contradicted, missing or new",
		);
		return undefined;
	}
	const suspectedCause = record.suspectedCause;
	if (
		suspectedCause !== undefined &&
		suspectedCause !== "product-change" &&
		suspectedCause !== "regression" &&
		suspectedCause !== "unknown"
	) {
		issues.add(
			`${path}.suspectedCause`,
			"data-block-knowledge",
			"suspectedCause must be product-change, regression or unknown",
		);
		return undefined;
	}
	if (concept === undefined) return undefined;
	return {
		concept,
		kind,
		...(section === undefined ? {} : { section }),
		...(suspectedCause === undefined ? {} : { suspectedCause }),
	};
}

function checkCaptures(
	value: unknown,
	issues: Issues,
	path: string,
): Readonly<Record<string, string>> | undefined {
	const record = issues.object(value, path);
	if (!record) return undefined;
	const entries = Object.entries(record);
	if (entries.length > 20)
		issues.add(path, "data-block-captures", "at most 20 captures per entry");
	const parsed: Record<string, string> = {};
	for (const [name, capture] of entries) {
		if (!/^[A-Za-z][A-Za-z0-9 _-]*$/.test(name)) {
			issues.add(
				`${path}.${name}`,
				"data-block-captures",
				"a capture name is plain text",
			);
			continue;
		}
		const text = issues.text(
			capture,
			`${path}.${name}`,
			"data-block-captures",
			DATA_BLOCK_MAX_TEXT,
		);
		if (text !== undefined) parsed[name] = text;
	}
	return parsed;
}

function checkStringArray(
	value: unknown,
	issues: Issues,
	path: string,
	code: string,
	pattern?: RegExp,
): readonly string[] | undefined {
	const entries = issues.array(value, path, 16);
	if (!entries) return undefined;
	const parsed: string[] = [];
	for (const [index, entry] of entries.entries()) {
		const text = issues.text(entry, `${path}[${index}]`, code, 128);
		if (text === undefined) continue;
		if (pattern && !pattern.test(text))
			issues.add(`${path}[${index}]`, code, `${quoted(text)} is invalid`);
		parsed.push(text);
	}
	if (new Set(parsed).size !== parsed.length)
		issues.add(path, code, "array repeats an entry");
	return parsed;
}

/** The declared property names of one schema, or none when the schema is not a
 * readable object schema. A document that has already failed validation can
 * still be asked this question — `validateDataBlock` runs over untrusted JSON —
 * so a missing or malformed schema is an empty set here, never a throw: a
 * validator that crashes on bad input is a crash in the replay path, not a
 * diagnostic. */
function objectPropertyNames(
	schema: JsonSchema | undefined,
): ReadonlySet<string> {
	if (schema === undefined || schema === null || typeof schema !== "object")
		return new Set();
	if ("anyOf" in schema || schema.type !== "object") return new Set();
	return new Set(Object.keys((schema as ObjectSchema).properties ?? {}));
}

/** Validate one untrusted document, including every structural, reference and
 * bound rule the interpreter relies on. */
/** One action as a reviewer reads it: the pure form used by the report, the
 * plan-review page and the catalog tool output, so the three never describe the
 * same operation differently. */
export function describeDataBlockAction(action: DataBlockAction): string {
	const target =
		"target" in action ? describeDataBlockTarget(action.target) : "";
	switch (action.op) {
		case "goto":
			return `goto ${action.path}`;
		case "wait":
			return `wait ${action.ms}ms`;
		case "capture":
			return `capture ${action.label}`;
		case "click":
			return `click ${target}`;
		case "expectVisible":
			return `expect visible ${target}`;
		case "expectText":
			return `expect text ${target} = ${action.text}`;
		case "fill":
			return `fill ${target} = ${describeDataBlockValue(action.value)}`;
		case "type":
			return `type ${target} = ${describeDataBlockValue(action.value)}`;
		case "press":
			return `press ${action.key} on ${target}`;
		case "select":
			return `select ${target} = ${action.values.map(describeDataBlockValue).join(", ")}`;
		case "waitFor":
			return `wait for ${target}${action.state ? ` (${action.state})` : ""}`;
		case "read":
			return `read ${target} into ${action.into}`;
	}
}

function describeDataBlockTarget(target: DataBlockTarget): string {
	if (target.role !== undefined)
		return `role=${target.role}${target.name === undefined ? "" : ` name=${target.name}`}`;
	if (target.label !== undefined) return `label=${target.label}`;
	if (target.testId !== undefined) return `testId=${target.testId}`;
	if (target.text !== undefined) return `text=${target.text}`;
	return `selector=${target.selector ?? "?"}`;
}

function describeDataBlockValue(value: DataBlockValue): string {
	return typeof value === "string" ? value : `secret ${value.secret}`;
}

/** The flat, reviewer-facing line list of one document's operations. */
export function describeDataBlockOperations(
	operations: readonly StageDataBlockOperation[],
	indent = "",
): string[] {
	return operations.flatMap((operation) =>
		operation.op === "optional"
			? [
					`${indent}optional (${operation.reason})`,
					...operation.operations.map(
						(action) => `${indent}  ${describeDataBlockAction(action)}`,
					),
				]
			: [
					`${indent}step ${operation.label}`,
					...operation.operations.map(
						(action) => `${indent}  ${describeDataBlockAction(action)}`,
					),
				],
	);
}

export function validateDataBlock(value: unknown): DataBlockValidation {
	const issues = new Issues();
	if (typeof value === "string")
		return {
			ok: false,
			issues: [
				{
					path: "",
					code: "data-block-shape",
					message: "a data block is a JSON object, not a string",
				},
			],
		};
	if (byteLength(JSON.stringify(value) ?? "") > DATA_BLOCK_MAX_BYTES)
		issues.add(
			"",
			"data-block-size",
			`a data block document is at most ${DATA_BLOCK_MAX_BYTES} bytes`,
		);
	const record = issues.object(value, "");
	if (!record) return { ok: false, issues: issues.items };
	issues.onlyKeys(record, DOCUMENT_KEYS, "");
	if (record.format !== DATA_BLOCK_FORMAT)
		issues.add(
			"format",
			"data-block-format",
			`format must be ${DATA_BLOCK_FORMAT}`,
		);
	const id = issues.text(record.id, "id", "data-block-id", 160);
	if (id !== undefined && !ID_PATTERN.test(id))
		issues.add(
			"id",
			"data-block-id",
			`${quoted(id)} must look like app.intentName`,
		);
	const version = issues.text(
		record.version,
		"version",
		"data-block-version",
		32,
	);
	if (version !== undefined && !VERSION_PATTERN.test(version))
		issues.add("version", "data-block-version", "version must be semver");
	const app = issues.text(record.app, "app", "data-block-app", 64);
	if (app !== undefined && !APP_PATTERN.test(app))
		issues.add(
			"app",
			"data-block-app",
			`${quoted(app)} is not an application key`,
		);
	if (record.roles !== undefined)
		checkStringArray(record.roles, issues, "roles", "data-block-role");
	issues.text(record.title, "title", "data-block-title", 160);
	issues.text(
		record.description,
		"description",
		"data-block-description",
		DATA_BLOCK_MAX_TEXT,
	);
	const effects = issues.array(record.effects, "effects", 3);
	const parsedEffects: BlockEffect[] = [];
	for (const [index, effect] of (effects ?? []).entries()) {
		if (effect !== "read" && effect !== "write" && effect !== "destructive") {
			issues.add(
				`effects[${index}]`,
				"data-block-effects",
				"effect must be read, write or destructive",
			);
			continue;
		}
		if (effect === "destructive")
			issues.add(
				`effects[${index}]`,
				"data-block-effects",
				"a data block may never declare a destructive effect",
			);
		parsedEffects.push(effect);
	}
	if (new Set(parsedEffects).size !== parsedEffects.length)
		issues.add("effects", "data-block-effects", "effects repeat");
	issues.boolean(record.idempotent, "idempotent", "data-block-idempotency");
	for (const name of ["requires", "provides"] as const)
		if (record[name] !== undefined)
			checkStringArray(
				record[name],
				issues,
				name,
				"data-block-state",
				STATE_PATTERN,
			);
	// A schema that already failed is never dereferenced: `params: "nope"`,
	// `null` or `7` is untrusted input from a document, a sidecar or the store,
	// and `"anyOf" in 7` throws instead of refusing the document
	// (`QUALITY-001`). The name is remembered so the examples below are not
	// validated against a schema this layer could not read.
	const unusableSchemas = new Set<string>();
	for (const name of ["params", "returns"] as const) {
		const schema = record[name];
		if (schema === undefined) {
			issues.add(name, "data-block-schema", "value is required");
			unusableSchemas.add(name);
			continue;
		}
		const problems = validateSchemaDefinition(schema, name);
		for (const problem of problems)
			issues.add(problem.path, "data-block-schema", problem.message);
		if (!isRecord(schema) || "anyOf" in schema || schema.type !== "object") {
			issues.add(name, "data-block-schema", "must be an object schema");
			unusableSchemas.add(name);
			continue;
		}
		if (schema.additionalProperties !== false)
			issues.add(
				name,
				"data-block-schema",
				"must set additionalProperties: false",
			);
	}
	const paramNames = objectPropertyNames(record.params as JsonSchema);
	const returnNames = objectPropertyNames(record.returns as JsonSchema);
	const examples = issues.array(record.examples, "examples", 10);
	for (const [index, example] of (examples ?? []).entries()) {
		if (examples && examples.length > 3 && index >= 3)
			issues.add(
				"examples",
				"data-block-examples",
				"a data block carries at most 3 validated examples",
			);
		if (!isRecord(example)) {
			issues.add(
				`examples[${index}]`,
				"data-block-examples",
				"expected an object",
			);
			continue;
		}
		if (unusableSchemas.has("params")) continue;
		for (const problem of validateSchemaValue(
			record.params as JsonSchema,
			example,
			`examples[${index}]`,
		))
			issues.add(problem.path, "data-block-examples", problem.message);
	}
	issues.text(
		record.postcondition,
		"postcondition",
		"data-block-postcondition",
		DATA_BLOCK_MAX_TEXT,
	);
	const operations = issues.array(
		record.operations,
		"operations",
		DATA_BLOCK_MAX_OPERATIONS,
	);
	const counter = { count: 0, expectations: 0 };
	const parsedOperations: StageDataBlockOperation[] = [];
	let stepCount = 0;
	for (const [index, entry] of (operations ?? []).entries()) {
		const path = `operations[${index}]`;
		const operation = issues.object(entry, path);
		if (!operation) continue;
		if (operation.op === "step") {
			stepCount += 1;
			issues.onlyKeys(operation, STEP_KEYS, path);
			const label = issues.text(
				operation.label,
				`${path}.label`,
				"data-block-step",
				DATA_BLOCK_MAX_LABEL,
			);
			if (label !== undefined)
				checkReferences(label, issues, `${path}.label`, paramNames);
			const expected = issues.text(
				operation.expected,
				`${path}.expected`,
				"data-block-step",
				DATA_BLOCK_MAX_TEXT,
				false,
			);
			const observed = issues.text(
				operation.observed,
				`${path}.observed`,
				"data-block-step",
				DATA_BLOCK_MAX_TEXT,
				false,
			);
			const captures =
				operation.captures === undefined
					? undefined
					: checkCaptures(operation.captures, issues, `${path}.captures`);
			const knowledge =
				operation.knowledge === undefined
					? undefined
					: checkKnowledge(operation.knowledge, issues, `${path}.knowledge`);
			const before = counter.expectations;
			const actions = checkActions(
				operation.operations,
				issues,
				`${path}.operations`,
				paramNames,
				returnNames,
				counter,
			);
			if (counter.expectations === before)
				issues.add(
					`${path}.operations`,
					"data-block-expectation",
					"a step needs at least one expectation (expectVisible or expectText)",
				);
			if (label === undefined || actions === undefined) continue;
			parsedOperations.push({
				op: "step",
				label,
				...(expected === undefined ? {} : { expected }),
				...(observed === undefined ? {} : { observed }),
				...(captures === undefined ? {} : { captures }),
				...(knowledge === undefined ? {} : { knowledge }),
				operations: actions,
			});
			continue;
		}
		if (operation.op === "optional") {
			issues.onlyKeys(operation, OPTIONAL_KEYS, path);
			const reason = issues.text(
				operation.reason,
				`${path}.reason`,
				"data-block-optional",
				DATA_BLOCK_MAX_TEXT,
			);
			const actions = checkActions(
				operation.operations,
				issues,
				`${path}.operations`,
				paramNames,
				returnNames,
				counter,
			);
			if (reason === undefined || actions === undefined) continue;
			parsedOperations.push({
				op: "optional",
				reason,
				operations: actions,
			});
			continue;
		}
		issues.add(
			path,
			"data-block-operation",
			"a top-level operation is a step or an optional group",
		);
	}
	if (stepCount === 0 && operations)
		issues.add(
			"operations",
			"data-block-step",
			"a block needs at least one step",
		);
	return {
		ok: issues.items.length === 0,
		issues: issues.items,
		...(issues.items.length === 0
			? { document: record as unknown as StageDataBlockDocument }
			: {}),
	};
}

function interpolate(
	value: string,
	args: Readonly<Record<string, JsonValue>>,
): string {
	return value.replace(ARGUMENT_REFERENCE, (_match, name: string) => {
		const resolved = args[name];
		if (resolved === undefined)
			throw new StageDataBlockError(
				"data-block-argument",
				`argument ${name} was not supplied`,
			);
		return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
	});
}

function resolveValue(
	value: DataBlockValue,
	ctx: StageContext,
	args: Readonly<Record<string, JsonValue>>,
): string {
	return typeof value === "string"
		? interpolate(value, args)
		: ctx.secret(value.secret);
}

function locatorFor(
	page: BlockPage,
	target: DataBlockTarget,
	args: Readonly<Record<string, JsonValue>>,
): BlockLocator {
	const at = (value: string): string => interpolate(value, args);
	if (target.role !== undefined)
		return page.getByRole(at(target.role), {
			...(target.name === undefined ? {} : { name: at(target.name) }),
			...(target.exact === undefined ? {} : { exact: target.exact }),
		});
	if (target.label !== undefined) return page.getByLabel(at(target.label));
	if (target.testId !== undefined) return page.getByTestId(at(target.testId));
	if (target.text !== undefined)
		return page.getByText(at(target.text), {
			...(target.exact === undefined ? {} : { exact: target.exact }),
		});
	if (target.selector !== undefined) return page.locator(at(target.selector));
	throw new StageDataBlockError(
		"data-block-target",
		"a target names no locator strategy",
	);
}

function stepDetails(
	operation: DataBlockStep,
	observed: () => string,
): () => BlockStepDetails {
	return () => {
		const failure = observed();
		const observedText = [operation.observed, failure]
			.filter(Boolean)
			.join("; ");
		return {
			...(operation.expected === undefined
				? {}
				: { expected: operation.expected }),
			...(observedText === "" ? {} : { observed: observedText }),
			...(operation.captures === undefined
				? {}
				: { captures: operation.captures }),
			...(operation.knowledge === undefined
				? {}
				: { knowledge: operation.knowledge }),
		};
	};
}

async function runActions(
	operations: readonly DataBlockAction[],
	ctx: StageContext,
	args: Readonly<Record<string, JsonValue>>,
	outputs: Record<string, JsonValue>,
): Promise<void> {
	for (const operation of operations) {
		switch (operation.op) {
			case "goto": {
				const path = interpolate(operation.path, args);
				const base = ctx.appUrl.replace(/\/+$/, "");
				await ctx.page.goto(`${base}${path}`);
				continue;
			}
			case "wait":
				await ctx.page.waitForTimeout(operation.ms);
				continue;
			case "capture":
				await ctx.capture(operation.label);
				continue;
			case "read": {
				const locator = locatorFor(ctx.page, operation.target, args);
				if (!(await locator.isVisible()))
					throw new StageDataBlockError(
						"data-block-read",
						`read target for ${operation.into} is not visible`,
					);
				const text = await locator.textContent();
				const value = text ?? "";
				outputs[operation.into] =
					operation.trim === true ? value.trim() : value;
				continue;
			}
			case "click":
				await locatorFor(ctx.page, operation.target, args).click();
				continue;
			case "fill":
				await locatorFor(ctx.page, operation.target, args).fill(
					resolveValue(operation.value, ctx, args),
				);
				continue;
			case "type":
				await locatorFor(ctx.page, operation.target, args).type(
					resolveValue(operation.value, ctx, args),
					{ delayMs: operation.delayMs ?? DATA_BLOCK_DEFAULT_DELAY_MS },
				);
				continue;
			case "press":
				await locatorFor(ctx.page, operation.target, args).press(operation.key);
				continue;
			case "select":
				await locatorFor(ctx.page, operation.target, args).selectOption(
					operation.values.map((value) => resolveValue(value, ctx, args)),
				);
				continue;
			case "waitFor":
				await locatorFor(ctx.page, operation.target, args).waitFor(
					operation.state === undefined
						? undefined
						: { state: operation.state },
				);
				continue;
			case "expectVisible":
				await ctx
					.expect(locatorFor(ctx.page, operation.target, args))
					.toBeVisible();
				continue;
			case "expectText":
				await ctx
					.expect(locatorFor(ctx.page, operation.target, args))
					.toContainText(interpolate(operation.text, args));
				continue;
		}
	}
}

/** Run one validated document against the same context a checked-in block
 * receives. Every `step` becomes one journal entry; an `optional` group is its
 * own entry and a failure inside it is recorded and swallowed. */
export async function interpretDataBlock(
	ctx: StageContext,
	document: StageDataBlockDocument,
	args: Readonly<Record<string, JsonValue>> = sampleArgs(document),
): Promise<Record<string, JsonValue>> {
	const outputs: Record<string, JsonValue> = {};
	for (const operation of document.operations) {
		if (operation.op === "optional") {
			await ctx
				.step(`optional: ${operation.reason}`, async () => {
					try {
						await runActions(operation.operations, ctx, args, outputs);
					} catch (error) {
						throw new StageDataBlockError(
							"data-block-optional",
							error instanceof Error ? error.message : String(error),
						);
					}
				})
				.catch(async () => {
					// The runner already recorded the failure; the block continues.
				});
			continue;
		}
		let observed = "";
		await ctx.step(
			interpolate(operation.label, args),
			async () => {
				try {
					await runActions(operation.operations, ctx, args, outputs);
				} catch (error) {
					observed = error instanceof Error ? error.message : String(error);
					throw error;
				}
			},
			stepDetails(operation, () => observed),
		);
	}
	const problems = validateSchemaValue(document.returns, outputs, "returns");
	if (problems.length > 0)
		throw new StageDataBlockError(
			"data-block-returns",
			`block ${document.id} did not produce its declared returns: ${problems
				.map((problem) => `${problem.path} ${problem.message}`)
				.join("; ")}`,
		);
	return outputs;
}

function sampleArgs(
	document: StageDataBlockDocument,
): Record<string, JsonValue> {
	return { ...((document.examples[0] ?? {}) as Record<string, JsonValue>) };
}

/** Compile one document to the frozen `BlockDefinition` the runner, plan,
 * catalog, flow generator and fixture all consume. */
export function compileDataBlock(
	document: StageDataBlockDocument,
): ReturnType<typeof defineBlock> {
	const validation = validateDataBlock(document);
	if (!validation.ok) {
		const [first] = validation.issues;
		throw new StageDataBlockError(
			first?.code ?? "data-block-invalid",
			`data block ${document.id ?? "(unknown)"} is invalid: ${first ? `${first.path} ${first.message}` : "unknown issue"}`,
		);
	}
	return compileValidatedDataBlock(validation.document ?? document);
}

/** Compile a document that has already been through `validateDataBlock`.
 *
 * Every store read validates as it reads, so the registry composition would
 * otherwise validate the same bytes twice per block and per call (`PERF-103`).
 * The one rule this function trusts its caller for is exactly that: pass a
 * document you validated in this call, never one from a request body. */
export function compileValidatedDataBlock(
	frozen: StageDataBlockDocument,
): ReturnType<typeof defineBlock> {
	return defineBlock({
		id: frozen.id,
		version: frozen.version,
		app: frozen.app,
		...(frozen.roles === undefined ? {} : { roles: frozen.roles }),
		title: frozen.title,
		description: frozen.description,
		params: frozen.params,
		returns: frozen.returns,
		effects: frozen.effects,
		idempotent: frozen.idempotent,
		...(frozen.requires === undefined ? {} : { requires: frozen.requires }),
		...(frozen.provides === undefined ? {} : { provides: frozen.provides }),
		examples: frozen.examples,
		data: frozen,
		run: (ctx: StageContext, args: Record<string, JsonValue>) =>
			interpretDataBlock(ctx, frozen, args),
	} as Parameters<typeof defineBlock>[0]);
}
