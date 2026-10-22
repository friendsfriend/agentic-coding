// The tiny, data-only schema language of the stage block layer.
//
// Blocks are reviewed code and their parameter and return contracts have to be
// visible to the planner without importing the block module into the model. The
// schema therefore stays plain JSON Schema: no functions, no transforms, no
// custom keywords. That also makes the generated catalog a plain JSON document
// and keeps the dry-run validator independent from any particular schema
// library.

import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ObjectSchema {
	readonly type: "object";
	readonly properties: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
	readonly description?: string;
}

export interface ArraySchema {
	readonly type: "array";
	readonly items: JsonSchema;
	readonly maxItems?: number;
	readonly description?: string;
}

export interface StringSchema {
	readonly type: "string";
	readonly enum?: readonly string[];
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly default?: string;
	readonly description?: string;
}

export interface NumberSchema {
	readonly type: "number" | "integer";
	readonly minimum?: number;
	readonly maximum?: number;
	readonly default?: number;
	readonly description?: string;
}

export interface BooleanSchema {
	readonly type: "boolean";
	readonly default?: boolean;
	readonly description?: string;
}

export interface NullSchema {
	readonly type: "null";
	readonly description?: string;
}

export interface AnyOfSchema {
	readonly anyOf: readonly JsonSchema[];
	readonly description?: string;
}

export type JsonSchema =
	| ObjectSchema
	| ArraySchema
	| StringSchema
	| NumberSchema
	| BooleanSchema
	| NullSchema
	| AnyOfSchema;

/** One bounded validation issue. `path` is a JSON path such as `args.street`;
 * `code` is stable so a plan can carry it without parsing the message. */
export interface SchemaIssue {
	readonly path: string;
	readonly code: string;
	readonly message: string;
}

export class StageBlockSchemaError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StageBlockSchemaError";
	}
}

const SUPPORTED_TYPES = new Set([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(path: string, code: string, message: string): SchemaIssue {
	return { path, code, message };
}

/** Definition-time check: a block cannot declare a schema this layer cannot
 * validate. It is deliberately stricter than JSON Schema, because an unknown
 * keyword that is silently ignored would make the catalog lie. */
export function validateSchemaDefinition(
	schema: unknown,
	path = "schema",
): SchemaIssue[] {
	if (!isRecord(schema)) {
		return [issue(path, "schema-object", "schema must be an object")];
	}
	const type = schema.type;
	if (type === undefined) {
		if (Array.isArray(schema.anyOf)) {
			if (schema.anyOf.length === 0)
				return [issue(path, "schema-anyof", "anyOf needs at least one schema")];
			return schema.anyOf.flatMap((entry, index) =>
				validateSchemaDefinition(entry, `${path}.anyOf[${index}]`),
			);
		}
		return [issue(path, "schema-type", "schema needs a type or anyOf")];
	}
	if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
		return [
			issue(
				path,
				"schema-type",
				`schema type ${String(type)} is not a supported JSON type`,
			),
		];
	}
	const issues: SchemaIssue[] = [];
	if (
		schema.description !== undefined &&
		typeof schema.description !== "string"
	)
		issues.push(
			issue(
				`${path}.description`,
				"schema-description",
				"description must be a string",
			),
		);
	if (type === "object") {
		if (!isRecord(schema.properties))
			issues.push(
				issue(
					`${path}.properties`,
					"schema-properties",
					"an object schema needs properties",
				),
			);
		else {
			for (const [name, property] of Object.entries(schema.properties))
				issues.push(
					...validateSchemaDefinition(property, `${path}.properties.${name}`),
				);
		}
		if (schema.required !== undefined) {
			if (
				!Array.isArray(schema.required) ||
				schema.required.some((entry) => typeof entry !== "string")
			)
				issues.push(
					issue(
						`${path}.required`,
						"schema-required",
						"required must be an array of names",
					),
				);
			else {
				for (const name of schema.required) {
					if (
						!isRecord(schema.properties) ||
						!Object.hasOwn(schema.properties, name)
					)
						issues.push(
							issue(
								`${path}.required`,
								"schema-required-unknown",
								`required property ${name} is not declared`,
							),
						);
				}
			}
		}
		if (
			schema.additionalProperties !== undefined &&
			typeof schema.additionalProperties !== "boolean"
		)
			issues.push(
				issue(
					`${path}.additionalProperties`,
					"schema-additional",
					"additionalProperties must be a boolean",
				),
			);
	}
	if (type === "array") {
		issues.push(...validateSchemaDefinition(schema.items, `${path}.items`));
		if (
			schema.maxItems !== undefined &&
			(typeof schema.maxItems !== "number" ||
				!Number.isInteger(schema.maxItems) ||
				schema.maxItems <= 0)
		)
			issues.push(
				issue(
					`${path}.maxItems`,
					"schema-max-items",
					"maxItems must be a positive integer",
				),
			);
	}
	if (type === "string") {
		if (
			schema.enum !== undefined &&
			(!Array.isArray(schema.enum) ||
				schema.enum.length === 0 ||
				schema.enum.some((entry) => typeof entry !== "string"))
		)
			issues.push(
				issue(
					`${path}.enum`,
					"schema-enum",
					"enum must be a non-empty string array",
				),
			);
		if (
			schema.minLength !== undefined &&
			(typeof schema.minLength !== "number" ||
				!Number.isInteger(schema.minLength) ||
				schema.minLength < 0)
		)
			issues.push(
				issue(
					`${path}.minLength`,
					"schema-min-length",
					"minLength must be a non-negative integer",
				),
			);
		if (
			schema.maxLength !== undefined &&
			(typeof schema.maxLength !== "number" ||
				!Number.isInteger(schema.maxLength) ||
				schema.maxLength <= 0)
		)
			issues.push(
				issue(
					`${path}.maxLength`,
					"schema-max-length",
					"maxLength must be a positive integer",
				),
			);
		if (schema.pattern !== undefined) {
			if (typeof schema.pattern !== "string")
				issues.push(
					issue(
						`${path}.pattern`,
						"schema-pattern",
						"pattern must be a string",
					),
				);
			else {
				try {
					new RegExp(schema.pattern);
				} catch {
					issues.push(
						issue(
							`${path}.pattern`,
							"schema-pattern",
							"pattern is not a valid regular expression",
						),
					);
				}
			}
		}
		if (schema.default !== undefined && typeof schema.default !== "string")
			issues.push(
				issue(`${path}.default`, "schema-default", "default must be a string"),
			);
	}
	if (type === "number" || type === "integer") {
		for (const key of ["minimum", "maximum"] as const) {
			const value = schema[key];
			if (value !== undefined && typeof value !== "number")
				issues.push(
					issue(
						`${path}.${key}`,
						"schema-number-bound",
						`${key} must be a number`,
					),
				);
		}
		if (schema.default !== undefined && typeof schema.default !== "number")
			issues.push(
				issue(`${path}.default`, "schema-default", "default must be a number"),
			);
		if (
			type === "integer" &&
			schema.default !== undefined &&
			!Number.isInteger(schema.default)
		)
			issues.push(
				issue(
					`${path}.default`,
					"schema-default",
					"integer default must be an integer",
				),
			);
	}
	if (
		type === "boolean" &&
		schema.default !== undefined &&
		typeof schema.default !== "boolean"
	)
		issues.push(
			issue(`${path}.default`, "schema-default", "default must be a boolean"),
		);
	return issues;
}

/** Validate one value against a definition-checked schema. */
export function validateSchemaValue(
	schema: JsonSchema,
	value: unknown,
	path = "value",
): SchemaIssue[] {
	// Every caller passes a schema it just read out of a document, a sidecar or
	// the store. `"anyOf" in 7` throws, so a caller that forgot its own guard
	// must get a refusal from here, never a crash in the replay path
	// (`QUALITY-001`).
	if (!isRecord(schema))
		return [issue(path, "schema-type", "schema is not an object")];
	if ("anyOf" in schema) {
		const failures = (
			schema as { readonly anyOf: readonly JsonSchema[] }
		).anyOf.map((entry) => validateSchemaValue(entry, value, path));
		if (failures.some((entry) => entry.length === 0)) return [];
		return [
			issue(
				path,
				"schema-anyof",
				`value does not match any allowed shape (${failures
					.map((entry) => entry[0]?.message)
					.filter(Boolean)
					.join("; ")})`,
			),
		];
	}
	if (schema.type === "object") {
		if (!isRecord(value))
			return [issue(path, "schema-type", "expected an object")];
		const issues: SchemaIssue[] = [];
		for (const name of schema.required ?? []) {
			if (!Object.hasOwn(value, name) || value[name] === undefined)
				issues.push(
					issue(path, "schema-required", `missing required property ${name}`),
				);
		}
		for (const [name, entry] of Object.entries(value)) {
			const property = schema.properties[name];
			if (property === undefined) {
				if (schema.additionalProperties === false)
					issues.push(
						issue(
							`${path}.${name}`,
							"schema-additional",
							`unexpected property ${name}`,
						),
					);
				continue;
			}
			if (entry === undefined) continue;
			issues.push(...validateSchemaValue(property, entry, `${path}.${name}`));
		}
		return issues;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value))
			return [issue(path, "schema-type", "expected an array")];
		const issues: SchemaIssue[] = [];
		if (schema.maxItems !== undefined && value.length > schema.maxItems)
			issues.push(
				issue(
					path,
					"schema-max-items",
					`expected at most ${schema.maxItems} items`,
				),
			);
		value.forEach((entry, index) => {
			issues.push(
				...validateSchemaValue(schema.items, entry, `${path}[${index}]`),
			);
		});
		return issues;
	}
	if (schema.type === "string") {
		if (typeof value !== "string")
			return [issue(path, "schema-type", "expected a string")];
		if (schema.enum !== undefined && !schema.enum.includes(value))
			return [
				issue(path, "schema-enum", `expected one of ${schema.enum.join(", ")}`),
			];
		if (schema.minLength !== undefined && value.length < schema.minLength)
			return [
				issue(
					path,
					"schema-min-length",
					`expected at least ${schema.minLength} characters`,
				),
			];
		if (schema.maxLength !== undefined && value.length > schema.maxLength)
			return [
				issue(
					path,
					"schema-max-length",
					`expected at most ${schema.maxLength} characters`,
				),
			];
		if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
			return [
				issue(path, "schema-pattern", "value does not match the pattern"),
			];
		return [];
	}
	if (schema.type === "number" || schema.type === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value))
			return [issue(path, "schema-type", `expected a ${schema.type}`)];
		if (schema.type === "integer" && !Number.isInteger(value))
			return [issue(path, "schema-type", "expected an integer")];
		if (schema.minimum !== undefined && value < schema.minimum)
			return [
				issue(path, "schema-minimum", `expected at least ${schema.minimum}`),
			];
		if (schema.maximum !== undefined && value > schema.maximum)
			return [
				issue(path, "schema-maximum", `expected at most ${schema.maximum}`),
			];
		return [];
	}
	if (schema.type === "boolean") {
		if (typeof value !== "boolean")
			return [issue(path, "schema-type", "expected a boolean")];
		return [];
	}
	if (schema.type === "null") {
		return value === null ? [] : [issue(path, "schema-type", "expected null")];
	}
	return [issue(path, "schema-type", "unsupported schema type")];
}

/** A deterministic sample used only for pre-browser type checking. It is never
 * executed and never becomes a plan value. */
export function sampleValue(schema: JsonSchema): JsonValue {
	if ("anyOf" in schema) {
		if (schema.anyOf.length === 0) return null;
		return sampleValue(schema.anyOf[0] as JsonSchema);
	}
	if (schema.type === "object") {
		const value: Record<string, JsonValue> = {};
		for (const name of schema.required ?? []) {
			const property = schema.properties[name];
			if (property !== undefined) value[name] = sampleValue(property);
		}
		return value;
	}
	if (schema.type === "array") return [];
	if (schema.type === "string")
		return schema.default ?? schema.enum?.[0] ?? "sample";
	if (schema.type === "number" || schema.type === "integer")
		return schema.default ?? schema.minimum ?? 0;
	if (schema.type === "boolean") return schema.default ?? false;
	return null;
}

/** Canonical JSON for hashes and the generated manifest: object keys are
 * sorted, arrays keep their order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new StageBlockSchemaError(
				"canonical-json",
				"a canonical document cannot contain a non-finite number",
			);
		return JSON.stringify(value);
	}
	if (Array.isArray(value))
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	throw new StageBlockSchemaError(
		"canonical-json",
		`a canonical document cannot contain ${typeof value}`,
	);
}

export function canonicalHash(value: unknown): string {
	return createCanonicalHash("sha256", value);
}

function createCanonicalHash(algorithm: "sha256", value: unknown): string {
	return `${algorithm}:${createHash(algorithm)
		.update(canonicalJson(value))
		.digest("hex")}`;
}

/** Read a dotted path without invoking getters or prototype members. */
export function readPath(value: unknown, path: string): unknown {
	let current = value;
	for (const segment of path.split(".")) {
		if (
			segment === "" ||
			segment === "__proto__" ||
			segment === "prototype" ||
			segment === "constructor"
		)
			return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length)
				return undefined;
			current = current[index];
			continue;
		}
		if (!isRecord(current) || !Object.hasOwn(current, segment))
			return undefined;
		current = current[segment];
	}
	return current;
}

/** The path keys of all input references in one value. */
export function inputReferences(value: unknown): string[] {
	return referencesOf(value, "inputs");
}

/** The route-step ids and output paths of all output references in one value. */
export function outputReferences(
	value: unknown,
): Array<{ routeStepId: string; path: string }> {
	const found: Array<{ routeStepId: string; path: string }> = [];
	for (const text of stringsOf(value)) {
		for (const match of text.matchAll(
			/\{\{\s*steps\.([A-Za-z0-9][A-Za-z0-9_-]*)\.outputs\.([A-Za-z0-9_.-]+)\s*\}\}/g,
		))
			found.push({ routeStepId: match[1] as string, path: match[2] as string });
	}
	return found;
}

/** True when the string is a whole binding, rather than a fragment embedded in
 * prose. Only whole bindings are legal in block arguments. */
export function isWholeBinding(value: string): boolean {
	return /^\{\{\s*(?:inputs\.[A-Za-z0-9_.-]+|steps\.[A-Za-z0-9][A-Za-z0-9_-]*\.outputs\.[A-Za-z0-9_.-]+)\s*\}\}$/.test(
		value,
	);
}

function stringsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap((entry) => stringsOf(entry));
	if (isRecord(value))
		return Object.values(value).flatMap((entry) => stringsOf(entry));
	return [];
}

function referencesOf(value: unknown, namespace: string): string[] {
	const names = new Set<string>();
	for (const text of stringsOf(value))
		for (const match of text.matchAll(
			new RegExp(
				`\\{\\{\\s*${namespace}\\.([A-Za-z0-9][A-Za-z0-9_.-]*)\\s*\\}\\}`,
				"g",
			),
		))
			names.add((match[1] as string).split(".")[0] as string);
	return [...names];
}
