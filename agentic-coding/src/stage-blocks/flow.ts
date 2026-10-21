// Flow identity and the sidecar manifest (`add-stage-flow-replay`).
//
// The generated spec is the review surface; `flow.json` is the machine-readable
// contract that makes a spec eligible. Input values are deliberately absent
// from the route hash: one reviewed route must serve many approved data sets.

import { type BlockDefinition, blockDigest } from "./define-block.ts";
import {
	deriveInputSchema,
	type NormalizedStageBlockPlan,
	type StageBlockPlanIssue,
} from "./plan.ts";
import type { StageBlockRegistry } from "./registry.ts";
import {
	canonicalHash,
	inputReferences,
	type JsonSchema,
	type JsonValue,
	outputReferences,
	validateSchemaDefinition,
	validateSchemaValue,
} from "./schema.ts";

export const STAGE_FLOW_MANIFEST_VERSION = 1 as const;
export const STAGE_FLOW_DIRECTORY = "stage-flows";

export interface FlowRouteMeta {
	readonly id: string;
	readonly application: string;
	readonly role?: string;
	readonly expectationIds: readonly string[];
	readonly captures: readonly string[];
}

export interface FlowExpectation {
	readonly id: string;
	readonly statement: string;
	readonly priority: "critical" | "high" | "medium" | "low";
}

export interface FlowSource {
	readonly flowId: string;
	readonly title?: string;
	readonly stage: string;
	readonly stages?: readonly string[];
	readonly planId: string;
	readonly revision?: number;
	readonly inputs: Readonly<Record<string, JsonValue>>;
	readonly steps: NormalizedStageBlockPlan["steps"];
	readonly routeMeta: readonly FlowRouteMeta[];
	readonly expectations: readonly FlowExpectation[];
}

export interface FlowRouteStep {
	readonly routeStepId: string;
	readonly block: string;
	readonly inputs: readonly string[];
	readonly outputs: readonly string[];
	readonly expectationIds: readonly string[];
	readonly captures: readonly string[];
}

export interface FlowManifest {
	readonly version: typeof STAGE_FLOW_MANIFEST_VERSION;
	readonly flowId: string;
	readonly title: string;
	readonly generatedFrom: {
		readonly planId: string;
		readonly revision?: number;
	};
	readonly stage: string;
	readonly stages?: readonly string[];
	readonly applications: readonly string[];
	readonly roles: readonly string[];
	readonly inputSchema: JsonSchema;
	readonly inputExamples: readonly Readonly<Record<string, JsonValue>>[];
	readonly routeHash: string;
	readonly specHash: string;
	readonly blockVersions: Readonly<Record<string, string>>;
	readonly blockDigests: Readonly<Record<string, string>>;
	readonly routeSteps: readonly FlowRouteStep[];
	readonly severityOverrides?: Readonly<
		Record<string, "critical" | "major" | "minor" | "info">
	>;
	readonly createdData?: readonly string[];
}

export interface FlowGenerationIssue extends StageBlockPlanIssue {
	readonly code: string;
}

export class FlowError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "FlowError";
	}
}

export function canonicalInputsHash(
	inputs: Readonly<Record<string, JsonValue>>,
): string {
	return canonicalHash(inputs);
}

/** The reviewed route identity. It deliberately excludes input values, the
 * source plan revision and every generated hash. Literal arguments and binding
 * placeholders are included, because changing either changes the test. */
export function routeHashFor(source: FlowSource): string {
	return canonicalHash({
		flowId: source.flowId,
		routeSteps: source.steps.map((step) => {
			const meta = source.routeMeta.find((entry) => entry.id === step.id);
			return {
				routeStepId: step.id,
				application: meta?.application ?? step.definition.app,
				role: meta?.role ?? null,
				block: step.definition.id,
				args: step.args,
				save: step.save ?? false,
				expectationIds: [...(meta?.expectationIds ?? [])].sort(),
				captures: [...(meta?.captures ?? [])].sort(),
			};
		}),
	});
}

export function routeStepProjection(
	step: NormalizedStageBlockPlan["steps"][number],
	meta: FlowRouteMeta | undefined,
): FlowRouteStep {
	const inputs = [
		...new Set(
			inputReferences(step.args).map((name) => name.split(".")[0] as string),
		),
	].sort();
	const outputs = [
		...new Set(
			outputReferences(step.args).map(
				(reference) => `${reference.routeStepId}.${reference.path}`,
			),
		),
	].sort();
	return {
		routeStepId: step.id,
		block: step.definition.id,
		inputs,
		outputs,
		expectationIds: [...(meta?.expectationIds ?? [])].sort(),
		captures: [...(meta?.captures ?? [])].sort(),
	};
}

/** Derive and validate the input contract before anything is generated. */
export function flowInputContract(
	source: FlowSource,
	registry: StageBlockRegistry,
): {
	readonly schema: JsonSchema;
	readonly issues: readonly FlowGenerationIssue[];
} {
	const issues: FlowGenerationIssue[] = [];
	const plan = {
		flowId: source.flowId,
		inputs: source.inputs,
		steps: source.steps.map((step) => ({
			id: step.id,
			block: step.definition.id,
			version: step.definition.version,
			args: step.args,
			...(step.save === undefined ? {} : { save: step.save }),
		})),
	};
	const derived = deriveInputSchema(plan, registry);
	issues.push(...derived.issues);
	if (issues.length === 0) {
		for (const problem of validateSchemaValue(
			derived.schema,
			source.inputs,
			"inputs",
		))
			issues.push({
				code:
					problem.code === "schema-required"
						? "flow-input-missing"
						: "flow-inputs-invalid",
				message: problem.message,
				field: problem.path,
			});
	}
	const declared = new Set(
		Object.keys(
			"type" in derived.schema && derived.schema.type === "object"
				? derived.schema.properties
				: {},
		),
	);
	for (const name of Object.keys(source.inputs))
		if (!declared.has(name))
			issues.push({
				code: "flow-input-undeclared",
				message: `input ${name} is not used by any block binding`,
				field: `inputs.${name}`,
			});
	return { schema: derived.schema, issues };
}

export function flowBlockIdentity(source: FlowSource): {
	readonly versions: Record<string, string>;
	readonly digests: Record<string, string>;
} {
	const versions: Record<string, string> = {};
	const digests: Record<string, string> = {};
	for (const step of source.steps) {
		versions[step.definition.id] = step.definition.version;
		digests[step.definition.id] = blockDigest(step.definition);
	}
	return { versions, digests };
}

export function buildFlowManifest(
	source: FlowSource,
	registry: StageBlockRegistry,
	specHash: string,
): {
	readonly manifest?: FlowManifest;
	readonly issues: readonly FlowGenerationIssue[];
} {
	const issues: FlowGenerationIssue[] = [];
	const contract = flowInputContract(source, registry);
	issues.push(...contract.issues);
	if (source.steps.length === 0)
		issues.push({
			code: "flow-empty",
			message: "a saved flow needs at least one block step",
		});
	const metaById = new Map(source.routeMeta.map((meta) => [meta.id, meta]));
	const routeSteps = source.steps.map((step) => {
		const meta = metaById.get(step.id);
		if (meta === undefined)
			issues.push({
				code: "flow-route-step-mismatch",
				message: `step ${step.id} has no route metadata`,
				routeStepId: step.id,
			});
		if (
			meta !== undefined &&
			meta.application !== "" &&
			meta.application !== step.definition.app &&
			step.definition.app !== "*"
		)
			issues.push({
				code: "flow-route-step-mismatch",
				message: `step ${step.id} is routed as ${meta.application}, but ${step.definition.id} is scoped to ${step.definition.app}`,
				routeStepId: step.id,
			});
		return routeStepProjection(step, meta);
	});
	const applications = [
		...new Set(
			source.routeMeta
				.map((meta) => meta.application)
				.filter((application) => application !== ""),
		),
	].sort();
	const roles = [
		...new Set(
			source.routeMeta
				.map((meta) => meta.role)
				.filter((role): role is string => role !== undefined),
		),
	].sort();
	const mapped = new Set(routeSteps.flatMap((step) => step.expectationIds));
	for (const expectation of source.expectations)
		if (!mapped.has(expectation.id))
			issues.push({
				code: "flow-expectation-uncovered",
				message: `expectation ${expectation.id} is not mapped to a route step; the flow is not replay-eligible for this plan`,
				field: `expectations.${expectation.id}`,
			});
	const identity = flowBlockIdentity(source);
	if (issues.some((issue) => issue.code === "flow-expectation-uncovered")) {
		// Coverage is an eligibility condition, not a generation failure. The
		// manifest still records the gap so the review page can show it.
	}
	return {
		manifest: {
			version: STAGE_FLOW_MANIFEST_VERSION,
			flowId: source.flowId,
			title: source.title ?? titleFor(source.flowId),
			generatedFrom: {
				planId: source.planId,
				...(source.revision === undefined ? {} : { revision: source.revision }),
			},
			stage: source.stage,
			...(source.stages === undefined ? {} : { stages: source.stages }),
			applications,
			roles,
			inputSchema: contract.schema,
			inputExamples:
				Object.keys(source.inputs).length === 0 ? [] : [source.inputs],
			routeHash: routeHashFor(source),
			specHash,
			blockVersions: identity.versions,
			blockDigests: identity.digests,
			routeSteps,
		},
		issues,
	};
}

export function titleFor(flowId: string): string {
	return flowId
		.split("-")
		.filter((part) => part !== "")
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join(" ");
}

export function parseFlowManifest(value: unknown): {
	readonly manifest?: FlowManifest;
	readonly issues: readonly FlowGenerationIssue[];
} {
	const issues: FlowGenerationIssue[] = [];
	const fail = (code: string, message: string, field?: string) => {
		issues.push({ code, message, ...(field === undefined ? {} : { field }) });
	};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail("flow-manifest", "flow.json must be an object");
		return { issues };
	}
	const record = value as Record<string, unknown>;
	if (record.version !== STAGE_FLOW_MANIFEST_VERSION)
		fail(
			"flow-manifest-version",
			`flow.json version must be ${STAGE_FLOW_MANIFEST_VERSION}`,
		);
	for (const key of [
		"flowId",
		"title",
		"stage",
		"routeHash",
		"specHash",
	] as const)
		if (
			typeof record[key] !== "string" ||
			(record[key] as string).trim() === ""
		)
			fail("flow-manifest-field", `flow.json needs ${key}`, key);
	for (const key of [
		"applications",
		"roles",
		"inputExamples",
		"routeSteps",
	] as const)
		if (!Array.isArray(record[key]))
			fail("flow-manifest-field", `flow.json needs ${key}`, key);
	for (const key of ["blockVersions", "blockDigests"] as const)
		if (
			record[key] === null ||
			typeof record[key] !== "object" ||
			Array.isArray(record[key])
		)
			fail("flow-manifest-field", `flow.json needs ${key}`, key);
	const generatedFrom = record.generatedFrom;
	if (
		generatedFrom === null ||
		typeof generatedFrom !== "object" ||
		Array.isArray(generatedFrom) ||
		typeof (generatedFrom as Record<string, unknown>).planId !== "string"
	)
		fail(
			"flow-manifest-field",
			"flow.json needs generatedFrom.planId",
			"generatedFrom",
		);
	const inputSchema = record.inputSchema;
	if (
		inputSchema === null ||
		typeof inputSchema !== "object" ||
		Array.isArray(inputSchema)
	)
		fail("flow-manifest-field", "flow.json needs inputSchema", "inputSchema");
	else
		for (const problem of validateSchemaDefinition(inputSchema, "inputSchema"))
			fail(problem.code, problem.message, problem.path);
	if (
		typeof record.flowId === "string" &&
		!/^[a-z][a-z0-9-]{0,62}$/.test(record.flowId)
	)
		fail(
			"flow-id",
			"flowId must start with a lowercase letter and contain lowercase letters, digits or -",
			"flowId",
		);
	if (
		typeof record.routeHash === "string" &&
		!/^sha256:[a-f0-9]{64}$/.test(record.routeHash)
	)
		fail("flow-hash", "routeHash must be a sha256 hash", "routeHash");
	if (
		typeof record.specHash === "string" &&
		!/^sha256:[a-f0-9]{64}$/.test(record.specHash)
	)
		fail("flow-hash", "specHash must be a sha256 hash", "specHash");
	if (
		generatedFrom !== null &&
		typeof generatedFrom === "object" &&
		!Array.isArray(generatedFrom)
	) {
		const revision = (generatedFrom as Record<string, unknown>).revision;
		if (
			revision !== undefined &&
			(!Number.isInteger(revision) || (revision as number) < 1)
		)
			fail(
				"flow-manifest-field",
				"generatedFrom.revision must be a positive integer",
				"generatedFrom.revision",
			);
	}
	for (const key of ["applications", "roles", "inputExamples"] as const)
		if (Array.isArray(record[key]))
			for (const [index, entry] of (record[key] as unknown[]).entries()) {
				const valid =
					key === "inputExamples"
						? entry !== null &&
							typeof entry === "object" &&
							!Array.isArray(entry)
						: typeof entry === "string" && entry.trim() !== "";
				if (!valid)
					fail(
						"flow-manifest-field",
						`flow.json ${key}[${index}] is invalid`,
						`${key}[${index}]`,
					);
			}
	if (Array.isArray(record.routeSteps)) {
		const ids = new Set<string>();
		for (const [index, entry] of (record.routeSteps as unknown[]).entries()) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				fail(
					"flow-manifest-field",
					`flow.json routeSteps[${index}] must be an object`,
					`routeSteps[${index}]`,
				);
				continue;
			}
			const step = entry as Record<string, unknown>;
			for (const key of ["routeStepId", "block"] as const)
				if (typeof step[key] !== "string" || step[key].trim() === "")
					fail(
						"flow-manifest-field",
						`flow.json routeSteps[${index}].${key} must be a non-empty string`,
						`routeSteps[${index}].${key}`,
					);
			if (typeof step.routeStepId === "string") {
				if (ids.has(step.routeStepId))
					fail(
						"flow-route-step-duplicate",
						`flow.json repeats route step ${step.routeStepId}`,
						step.routeStepId,
					);
				ids.add(step.routeStepId);
			}
			for (const key of [
				"inputs",
				"outputs",
				"expectationIds",
				"captures",
			] as const)
				if (
					!Array.isArray(step[key]) ||
					(step[key] as unknown[]).some(
						(value) => typeof value !== "string" || value.trim() === "",
					)
				)
					fail(
						"flow-manifest-field",
						`flow.json routeSteps[${index}].${key} must be an array of non-empty strings`,
						`routeSteps[${index}].${key}`,
					);
		}
	}
	for (const key of ["blockVersions", "blockDigests"] as const)
		if (
			record[key] !== null &&
			typeof record[key] === "object" &&
			!Array.isArray(record[key])
		)
			for (const [name, value] of Object.entries(
				record[key] as Record<string, unknown>,
			))
				if (typeof value !== "string" || value.trim() === "")
					fail(
						"flow-manifest-field",
						`flow.json ${key}.${name} must be a non-empty string`,
						`${key}.${name}`,
					);
	if (issues.length > 0) return { issues };
	return { manifest: value as unknown as FlowManifest, issues };
}

/** The route step metadata a stage plan supplies. A missing block is a gap, not
 * a route step: replay only compiles fully blocked plans. */
export function routeMetaFromStagePlan(
	route: readonly {
		readonly id: string;
		readonly application: string;
		readonly role?: string;
		readonly capture?: readonly string[];
		readonly expectationIds?: readonly string[];
	}[],
): FlowRouteMeta[] {
	return route.map((entry) => ({
		id: entry.id,
		application: entry.application,
		...(entry.role === undefined ? {} : { role: entry.role }),
		expectationIds: [...(entry.expectationIds ?? [])],
		captures: [...(entry.capture ?? [])],
	}));
}

/** A compact, value-free comparison for the plan review and the workflow. */
export function flowIdentity(manifest: FlowManifest): {
	readonly flowId: string;
	readonly routeHash: string;
	readonly specHash: string;
	readonly blockVersions: Readonly<Record<string, string>>;
} {
	return {
		flowId: manifest.flowId,
		routeHash: manifest.routeHash,
		specHash: manifest.specHash,
		blockVersions: manifest.blockVersions,
	};
}

export function blockForStep(
	step: NormalizedStageBlockPlan["steps"][number],
): BlockDefinition {
	return step.definition;
}
