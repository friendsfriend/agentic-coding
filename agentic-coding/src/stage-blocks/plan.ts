// Validation happens before a browser is opened. A plan is a small data
// document: ordered steps, typed input values and whole-string references. It
// deliberately has no expression language, no selectors-as-code and no
// functions. That is what lets `stage_run` explain every refusal without
// touching a page.

import type { BlockDefinition } from "./define-block.ts";
import type { StageBlockRegistry } from "./registry.ts";
import {
	canonicalHash,
	canonicalJson,
	inputReferences,
	isWholeBinding,
	type JsonSchema,
	type JsonValue,
	outputReferences,
	readPath,
	sampleValue,
	validateSchemaValue,
} from "./schema.ts";

export const MAX_STAGE_BLOCK_STEPS = 100;
export const MAX_STAGE_BLOCK_INPUTS = 50;

export interface StageBlockStep {
	readonly id?: string;
	readonly block: string;
	readonly version?: string;
	readonly args?: Readonly<Record<string, JsonValue>>;
	readonly save?: boolean;
}

export interface StageBlockPlan {
	readonly planId?: string;
	readonly flowId?: string;
	readonly revision?: number;
	readonly inputs?: Readonly<Record<string, JsonValue>>;
	readonly steps: readonly StageBlockStep[];
}

export interface NormalizedStageBlockStep extends StageBlockStep {
	readonly id: string;
	readonly args: Readonly<Record<string, JsonValue>>;
	readonly definition: BlockDefinition;
}

export interface NormalizedStageBlockPlan {
	readonly planId: string;
	readonly flowId?: string;
	readonly revision?: number;
	readonly inputs: Readonly<Record<string, JsonValue>>;
	readonly inputsHash: string;
	readonly steps: readonly NormalizedStageBlockStep[];
	readonly versions: Readonly<Record<string, string>>;
}

export interface StageBlockPlanIssue {
	readonly code: string;
	readonly message: string;
	readonly stepIndex?: number;
	readonly routeStepId?: string;
	readonly block?: string;
	readonly field?: string;
}

export interface StageBlockPolicy {
	readonly stage: string;
	readonly access: "read-only" | "writable";
	readonly writeAllowed: boolean;
	readonly role?: string;
	readonly apps: Readonly<
		Record<string, { readonly roles?: readonly string[] }>
	>;
}

export interface ValidateStageBlockPlanOptions {
	readonly registry: StageBlockRegistry;
	readonly policy?: StageBlockPolicy;
	/** Values that must never appear in a plan argument or input. The caller
	 * uses the configuration's redaction secrets, so the refusal and the redactor
	 * agree. */
	readonly secretValues?: readonly string[];
}

export interface ValidatedStageBlockPlan {
	readonly ok: boolean;
	readonly issues: readonly StageBlockPlanIssue[];
	readonly plan?: NormalizedStageBlockPlan;
}

const FLOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const ROUTE_STEP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const INPUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function issue(
	code: string,
	message: string,
	fields: Omit<StageBlockPlanIssue, "code" | "message"> = {},
): StageBlockPlanIssue {
	return { code, message, ...fields };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedJson(value: unknown): value is JsonValue {
	try {
		canonicalJson(value);
		return true;
	} catch {
		return false;
	}
}

/** Whole-string bindings resolve against plan inputs or earlier outputs. Every
 * other string is a literal; a fragment that looks like a binding is refused,
 * because silently treating it as text would hide an intended reference. */
function resolveBinding(
	value: string,
	stepIndex: number,
	routeStepId: string,
	inputs: Readonly<Record<string, JsonValue>>,
	earlier: ReadonlyMap<string, BlockDefinition>,
	issues: StageBlockPlanIssue[],
): JsonValue | undefined {
	if (!value.includes("{{")) return value;
	if (!isWholeBinding(value)) {
		issues.push(
			issue(
				"binding-invalid",
				`${JSON.stringify(value)} is not a whole input or output binding`,
				{ stepIndex, routeStepId, field: "args" },
			),
		);
		return undefined;
	}
	const inputMatch = /^\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
	if (inputMatch) {
		const name = inputMatch[1] as string;
		if (!INPUT_NAME_PATTERN.test(name)) {
			issues.push(
				issue(
					"input-name",
					`input name ${name} must start with a letter and contain only letters, digits or _`,
					{ stepIndex, routeStepId, field: "args" },
				),
			);
			return undefined;
		}
		if (!Object.hasOwn(inputs, name)) {
			issues.push(
				issue("input-missing", `plan input ${name} is not declared`, {
					stepIndex,
					routeStepId,
					field: `inputs.${name}`,
				}),
			);
			return undefined;
		}
		return inputs[name];
	}
	const outputMatch =
		/^\{\{\s*steps\.([A-Za-z0-9][A-Za-z0-9_-]*)\.outputs\.([A-Za-z0-9_.-]+)\s*\}\}$/.exec(
			value,
		);
	if (!outputMatch) {
		issues.push(
			issue("binding-invalid", "binding is not an input or output reference", {
				stepIndex,
				routeStepId,
				field: "args",
			}),
		);
		return undefined;
	}
	const dependency = outputMatch[1] as string;
	const path = outputMatch[2] as string;
	const definition = earlier.get(dependency);
	if (definition === undefined) {
		issues.push(
			issue(
				"output-reference-forward",
				`step ${routeStepId} reads ${dependency}'s output before it has run`,
				{ stepIndex, routeStepId, field: "args" },
			),
		);
		return undefined;
	}
	const sample = readPath(sampleValue(definition.returns), path);
	if (sample === undefined) {
		issues.push(
			issue(
				"output-reference-missing",
				`block ${definition.id} does not declare output ${path}`,
				{ stepIndex, routeStepId, field: "args" },
			),
		);
		return undefined;
	}
	return sample as JsonValue;
}

function resolveArgs(
	value: JsonValue,
	stepIndex: number,
	routeStepId: string,
	inputs: Readonly<Record<string, JsonValue>>,
	earlier: ReadonlyMap<string, BlockDefinition>,
	issues: StageBlockPlanIssue[],
): JsonValue {
	if (typeof value === "string") {
		return (
			resolveBinding(value, stepIndex, routeStepId, inputs, earlier, issues) ??
			""
		);
	}
	if (Array.isArray(value))
		return value.map((entry) =>
			resolveArgs(entry, stepIndex, routeStepId, inputs, earlier, issues),
		);
	if (isRecord(value)) {
		const resolved: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value))
			resolved[key] = resolveArgs(
				entry as JsonValue,
				stepIndex,
				routeStepId,
				inputs,
				earlier,
				issues,
			);
		return resolved;
	}
	return value as JsonValue;
}

function containsSecret(value: JsonValue, secrets: readonly string[]): boolean {
	if (typeof value === "string")
		return secrets.some((secret) => secret !== "" && value.includes(secret));
	if (Array.isArray(value))
		return value.some((entry) => containsSecret(entry, secrets));
	if (isRecord(value))
		return Object.values(value).some((entry) =>
			containsSecret(entry as JsonValue, secrets),
		);
	return false;
}

function checkPolicy(
	block: BlockDefinition,
	policy: StageBlockPolicy,
	step: { stepIndex: number; routeStepId: string },
	issues: StageBlockPlanIssue[],
): void {
	const app = policy.apps[block.app];
	if (block.app !== "*" && app === undefined) {
		issues.push(
			issue(
				"stage-app-mismatch",
				`stage ${policy.stage} does not declare application ${block.app}`,
				{ ...step, block: block.id, field: "app" },
			),
		);
	}
	if (
		policy.role !== undefined &&
		(block.roles ?? []).length > 0 &&
		!(block.roles ?? []).includes(policy.role)
	) {
		issues.push(
			issue(
				"stage-role-mismatch",
				`block ${block.id} is not approved for role ${policy.role}`,
				{ ...step, block: block.id, field: "role" },
			),
		);
	}
	if (app !== undefined && policy.role !== undefined) {
		const roles = app.roles;
		if (roles !== undefined && roles.length > 0 && !roles.includes(policy.role))
			issues.push(
				issue(
					"stage-role-mismatch",
					`stage ${policy.stage} application ${block.app} does not declare role ${policy.role}`,
					{ ...step, block: block.id, field: "role" },
				),
			);
	}
	const writes = block.effects.some(
		(effect) => effect === "write" || effect === "destructive",
	);
	if (block.effects.includes("destructive")) {
		issues.push(
			issue(
				"stage-action-destructive",
				`block ${block.id} performs a destructive action; stage runs refuse it`,
				{ ...step, block: block.id, field: "effects" },
			),
		);
		return;
	}
	if (!writes) return;
	if (policy.access === "read-only") {
		issues.push(
			issue(
				"stage-read-only",
				`block ${block.id} writes, but stage ${policy.stage} is read-only`,
				{ ...step, block: block.id, field: "effects" },
			),
		);
		return;
	}
	if (!policy.writeAllowed) {
		issues.push(
			issue(
				"stage-action-not-approved",
				`block ${block.id} writes, but the approved plan does not permit record creation`,
				{ ...step, block: block.id, field: "effects" },
			),
		);
	}
}

export function validateStageBlockPlan(
	plan: StageBlockPlan,
	options: ValidateStageBlockPlanOptions,
): ValidatedStageBlockPlan {
	const issues: StageBlockPlanIssue[] = [];
	if (!Array.isArray(plan.steps) || plan.steps.length === 0)
		issues.push(issue("plan-steps", "a plan needs at least one step"));
	if (plan.steps.length > MAX_STAGE_BLOCK_STEPS)
		issues.push(
			issue(
				"plan-step-limit",
				`a plan may have at most ${MAX_STAGE_BLOCK_STEPS} steps`,
			),
		);
	if (plan.flowId !== undefined && !FLOW_ID_PATTERN.test(plan.flowId))
		issues.push(
			issue(
				"flow-id",
				"flowId must start with a lowercase letter and contain lowercase letters, digits or -",
				{ field: "flowId" },
			),
		);
	const rawInputs = plan.inputs ?? {};
	if (!isRecord(rawInputs))
		issues.push(
			issue("plan-inputs", "inputs must be an object", { field: "inputs" }),
		);
	else if (Object.keys(rawInputs).length > MAX_STAGE_BLOCK_INPUTS)
		issues.push(
			issue(
				"plan-input-limit",
				`a plan may declare at most ${MAX_STAGE_BLOCK_INPUTS} inputs`,
				{ field: "inputs" },
			),
		);
	const inputs: Record<string, JsonValue> = {};
	if (isRecord(rawInputs)) {
		for (const [name, value] of Object.entries(rawInputs)) {
			if (!INPUT_NAME_PATTERN.test(name))
				issues.push(
					issue(
						"input-name",
						`input name ${name} must start with a letter and contain only letters, digits or _`,
						{ field: `inputs.${name}` },
					),
				);
			if (!boundedJson(value)) {
				issues.push(
					issue("plan-input-value", `input ${name} is not a JSON value`, {
						field: `inputs.${name}`,
					}),
				);
				continue;
			}
			inputs[name] = value as JsonValue;
		}
	}
	const secretValues = options.secretValues ?? [];
	if (containsSecret(inputs, secretValues))
		issues.push(
			issue(
				"plan-secret-literal",
				"a plan input contains a configured secret",
				{
					field: "inputs",
				},
			),
		);

	const normalized: NormalizedStageBlockStep[] = [];
	const earlier = new Map<string, BlockDefinition>();
	const usedRouteIds = new Set<string>();
	const provided = new Set<string>(["logged-out"]);
	for (const [index, step] of plan.steps.entries()) {
		const routeStepId = step.id ?? `step-${index + 1}`;
		const stepFields = { stepIndex: index, routeStepId };
		if (!ROUTE_STEP_PATTERN.test(routeStepId)) {
			issues.push(
				issue("route-step-id", `route step id ${routeStepId} is invalid`, {
					...stepFields,
					field: "id",
				}),
			);
		}
		if (usedRouteIds.has(routeStepId))
			issues.push(
				issue(
					"route-step-duplicate",
					`route step id ${routeStepId} appears more than once`,
					{ ...stepFields, field: "id" },
				),
			);
		usedRouteIds.add(routeStepId);
		const definition =
			step.version === undefined
				? options.registry.get(step.block)
				: options.registry.getVersion(step.block, step.version);
		if (definition === undefined) {
			issues.push(
				issue(
					"block-unknown",
					`block ${step.block}${
						step.version === undefined ? "" : `@${step.version}`
					} is not registered`,
					{ ...stepFields, block: step.block, field: "block" },
				),
			);
			continue;
		}
		if (step.args !== undefined && !isRecord(step.args))
			issues.push(
				issue("plan-args", "step args must be an object", {
					...stepFields,
					block: definition.id,
					field: "args",
				}),
			);
		const rawArgs = isRecord(step.args) ? step.args : {};
		if (containsSecret(rawArgs as Record<string, JsonValue>, secretValues))
			issues.push(
				issue(
					"plan-secret-literal",
					"a plan argument contains a configured secret",
					{ ...stepFields, block: definition.id, field: "args" },
				),
			);
		const resolvedArgs = resolveArgs(
			rawArgs as Record<string, JsonValue>,
			index,
			routeStepId,
			inputs,
			earlier,
			issues,
		);
		for (const problem of validateSchemaValue(
			definition.params,
			resolvedArgs,
			`steps[${index}].args`,
		))
			issues.push(
				issue("plan-args", problem.message, {
					...stepFields,
					block: definition.id,
					field: problem.path.replace(/^steps\[\d+\]\.args\.?/, "args."),
				}),
			);
		for (const required of definition.requires ?? []) {
			if (!provided.has(required))
				issues.push(
					issue(
						"block-requires-unmet",
						`block ${definition.id} requires state ${required}, which no earlier step provides`,
						{ ...stepFields, block: definition.id, field: "requires" },
					),
				);
		}
		for (const state of definition.provides ?? []) {
			if (provided.has(state))
				issues.push(
					issue(
						"block-provides-conflict",
						`block ${definition.id} provides state ${state} more than once`,
						{ ...stepFields, block: definition.id, field: "provides" },
					),
				);
			provided.add(state);
		}
		if (options.policy !== undefined)
			checkPolicy(definition, options.policy, stepFields, issues);
		earlier.set(routeStepId, definition);
		normalized.push({
			...step,
			id: routeStepId,
			args: rawArgs as Record<string, JsonValue>,
			definition,
		});
	}
	const inputsHash = canonicalHash(inputs);
	const planId =
		plan.planId ??
		`plan-${canonicalHash({
			flowId: plan.flowId ?? null,
			steps: plan.steps,
		}).slice("sha256:".length, "sha256:".length + 12)}`;
	const versions: Record<string, string> = {};
	for (const step of normalized)
		versions[step.definition.id] = step.definition.version;
	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		issues,
		plan: {
			planId,
			...(plan.flowId === undefined ? {} : { flowId: plan.flowId }),
			...(plan.revision === undefined ? {} : { revision: plan.revision }),
			inputs,
			inputsHash,
			steps: normalized,
			versions,
		},
	};
}

export interface DerivedInputSchema {
	readonly schema: JsonSchema;
	readonly issues: readonly StageBlockPlanIssue[];
}

/** Derive the runtime input contract from the same bindings the runner uses.
 * A name used in two blocks at incompatible types is a refusal, not a merged
 * "anything" schema. */
export function deriveInputSchema(
	plan: StageBlockPlan,
	registry: StageBlockRegistry,
): DerivedInputSchema {
	const issues: StageBlockPlanIssue[] = [];
	const properties: Record<string, JsonSchema> = {};
	const required = new Set<string>();
	const usages = new Map<
		string,
		Array<{ schema: JsonSchema; stepIndex: number; routeStepId: string }>
	>();
	for (const [index, step] of plan.steps.entries()) {
		const routeStepId = step.id ?? `step-${index + 1}`;
		const definition =
			step.version === undefined
				? registry.get(step.block)
				: registry.getVersion(step.block, step.version);
		if (definition === undefined) {
			issues.push(
				issue("block-unknown", `block ${step.block} is not registered`, {
					stepIndex: index,
					routeStepId,
					block: step.block,
				}),
			);
			continue;
		}
		collectInputUsages(
			step.args ?? {},
			definition.params,
			index,
			routeStepId,
			definition.id,
			usages,
			issues,
		);
	}
	for (const [name, list] of usages) {
		const first = list[0];
		if (first === undefined) continue;
		for (const usage of list.slice(1)) {
			if (
				canonicalHash(comparableSchema(first.schema)) ===
				canonicalHash(comparableSchema(usage.schema))
			)
				continue;
			issues.push(
				issue(
					"input-schema-conflict",
					`input ${name} is used at incompatible types in the same plan`,
					{
						stepIndex: usage.stepIndex,
						routeStepId: usage.routeStepId,
						field: `inputs.${name}`,
					},
				),
			);
			break;
		}
		properties[name] = first.schema;
		required.add(name);
	}
	return {
		schema: {
			type: "object",
			additionalProperties: false,
			properties,
			required: [...required].sort(),
		},
		issues,
	};
}

/** Descriptions and defaults are documentation, not part of an input's
 * executable type. Two blocks may describe the same `customerId` differently
 * without making one shared input incompatible. */
function comparableSchema(schema: JsonSchema): unknown {
	if ("anyOf" in schema) return { anyOf: schema.anyOf.map(comparableSchema) };
	switch (schema.type) {
		case "object":
			return {
				type: "object",
				properties: Object.fromEntries(
					Object.entries(schema.properties).map(([key, value]) => [
						key,
						comparableSchema(value),
					]),
				),
				required: [...(schema.required ?? [])].sort(),
			};
		case "array":
			return { type: "array", items: comparableSchema(schema.items) };
		case "string":
			return {
				type: "string",
				...(schema.enum === undefined ? {} : { enum: schema.enum }),
			};
		default:
			return { type: schema.type };
	}
}

function schemaAtPath(
	schema: JsonSchema,
	path: readonly string[],
): JsonSchema | undefined {
	let current = schema;
	for (const segment of path) {
		if ("anyOf" in current) return undefined;
		if (current.type === "object") {
			const next = current.properties[segment];
			if (next === undefined) return undefined;
			current = next;
			continue;
		}
		if (current.type === "array" && segment === "[]") {
			current = current.items;
			continue;
		}
		return undefined;
	}
	return current;
}

function collectInputUsages(
	value: unknown,
	schema: JsonSchema,
	stepIndex: number,
	routeStepId: string,
	block: string,
	usages: Map<
		string,
		Array<{ schema: JsonSchema; stepIndex: number; routeStepId: string }>
	>,
	issues: StageBlockPlanIssue[],
	path: readonly string[] = [],
): void {
	if (typeof value === "string") {
		if (!value.includes("{{")) return;
		if (!isWholeBinding(value)) {
			issues.push(
				issue(
					"binding-invalid",
					`${JSON.stringify(value)} is not a whole binding`,
					{
						stepIndex,
						routeStepId,
						block,
						field: `args.${path.join(".")}`,
					},
				),
			);
			return;
		}
		const match = /^\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
		if (!match) return;
		const name = match[1] as string;
		const target = schemaAtPath(schema, path);
		if (target === undefined) {
			issues.push(
				issue(
					"input-schema-unavailable",
					`cannot infer a type for input ${name} from block ${block}`,
					{ stepIndex, routeStepId, block, field: `inputs.${name}` },
				),
			);
			return;
		}
		const list = usages.get(name) ?? [];
		list.push({ schema: target, stepIndex, routeStepId });
		usages.set(name, list);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value)
			collectInputUsages(
				entry,
				schema,
				stepIndex,
				routeStepId,
				block,
				usages,
				issues,
				[...path, "[]"],
			);
		return;
	}
	if (isRecord(value)) {
		for (const [key, entry] of Object.entries(value))
			collectInputUsages(
				entry,
				schema,
				stepIndex,
				routeStepId,
				block,
				usages,
				issues,
				[...path, key],
			);
	}
}

/** The references a plan actually contains, used by the generator and by the
 * review projection. */
export function planReferences(plan: StageBlockPlan): {
	readonly inputs: string[];
	readonly outputs: Array<{ routeStepId: string; path: string }>;
} {
	return {
		inputs: [
			...new Set(
				plan.steps.flatMap((step) => inputReferences(step.args ?? {})),
			),
		].sort(),
		outputs: plan.steps.flatMap((step) => outputReferences(step.args ?? {})),
	};
}

/** Project a stage plan route with block metadata to the same linear block plan
 * the runner uses. The caller supplies the route subset; mixed plans are
 * represented by the gaps between block steps.
 *
 * A route step names exactly one of `block`, `blockToCreate` or
 * `blockToAdjust` (`noBlockReason` is the fourth, and produces a gap). A
 * create/adjust intent resolves to the block it names as soon as that block
 * exists — the tester saves the draft and the same route step becomes
 * executable — and stays a gap until then, so an authored-but-unsaved block is
 * reported as unblocked instead of as an unknown block. */
export interface RouteBlockReference {
	readonly id: string;
	readonly version?: string;
	readonly args?: Readonly<Record<string, JsonValue>>;
}

export function blockPlanFromRoute(
	route: readonly {
		readonly id: string;
		readonly application: string;
		readonly role?: string;
		readonly block?: RouteBlockReference;
		readonly blockToCreate?: RouteBlockReference;
		readonly blockToAdjust?: RouteBlockReference;
		readonly noBlockReason?: string;
	}[],
	top: {
		planId?: string;
		flowId?: string;
		revision?: number;
		inputs?: Readonly<Record<string, JsonValue>>;
		/** The composed registry, when the caller has one. Without it every
		 * create/adjust intent counts as resolvable; with it, one whose block is
		 * not registered yet is a gap (the draft has not been saved). */
		registry?: Pick<StageBlockRegistry, "get" | "getVersion">;
	},
): { readonly plan: StageBlockPlan; readonly missing: readonly string[] } {
	const steps: StageBlockStep[] = [];
	const missing: string[] = [];
	for (const entry of route) {
		const authored = entry.blockToCreate ?? entry.blockToAdjust;
		if (authored !== undefined && top.registry !== undefined) {
			const known =
				authored.version === undefined
					? top.registry.get(authored.id)
					: top.registry.getVersion(authored.id, authored.version);
			if (known === undefined) {
				missing.push(entry.id);
				continue;
			}
		}
		const reference = entry.block ?? authored;
		if (reference === undefined) {
			missing.push(entry.id);
			continue;
		}
		steps.push({
			id: entry.id,
			block: reference.id,
			...(reference.version === undefined
				? {}
				: { version: reference.version }),
			args: reference.args ?? {},
		});
	}
	return {
		plan: {
			...(top.planId === undefined ? {} : { planId: top.planId }),
			...(top.flowId === undefined ? {} : { flowId: top.flowId }),
			...(top.revision === undefined ? {} : { revision: top.revision }),
			...(top.inputs === undefined ? {} : { inputs: top.inputs }),
			steps,
		},
		missing,
	};
}
