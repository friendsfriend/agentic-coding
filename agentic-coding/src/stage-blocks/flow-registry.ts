// The on-disk flow registry and the eligibility decision
// (`add-stage-flow-replay`, task 2). A flow is eligible only when its reviewed
// spec, its sidecar manifest and the current block registry agree with the
// approved plan that is about to be replayed.

import fs from "node:fs";
import path from "node:path";
import { blockDigest } from "./define-block.ts";
import {
	type FlowGenerationIssue,
	type FlowManifest,
	type FlowRouteStep,
	type FlowSource,
	flowInputContract,
	parseFlowManifest,
	routeHashFor,
	routeStepProjection,
	STAGE_FLOW_DIRECTORY,
} from "./flow.ts";
import type { NormalizedStageBlockPlan } from "./plan.ts";
import type { StageBlockRegistry } from "./registry.ts";
import {
	canonicalHash,
	type JsonSchema,
	type JsonValue,
	validateSchemaValue,
} from "./schema.ts";

export type FlowEligibilityCode =
	| "flow-not-found"
	| "flow-manifest-invalid"
	| "flow-id-mismatch"
	| "flow-stage-mismatch"
	| "flow-spec-missing"
	| "flow-spec-drift"
	| "flow-route-drift"
	| "flow-route-step-mismatch"
	| "flow-input-schema-mismatch"
	| "flow-inputs-missing"
	| "flow-inputs-extra"
	| "flow-inputs-invalid"
	| "flow-block-unknown"
	| "flow-block-version"
	| "flow-block-digest"
	| "flow-app-missing"
	| "flow-role-missing"
	| "flow-expectation-uncovered";

export interface FlowRegistryEntry {
	readonly manifest: FlowManifest;
	readonly spec: string;
	readonly directory: string;
	readonly specPath: string;
}

export interface FlowEligibility {
	readonly eligible: boolean;
	readonly issues: readonly FlowGenerationIssue[];
}

function issue(
	code: FlowEligibilityCode,
	message: string,
	field?: string,
): FlowGenerationIssue {
	return { code, message, ...(field === undefined ? {} : { field }) };
}

export function flowDirectory(root: string, flowId: string): string {
	return path.join(root, STAGE_FLOW_DIRECTORY, flowId);
}

export function readFlowRegistry(root: string): {
	readonly entries: readonly FlowRegistryEntry[];
	readonly issues: readonly FlowGenerationIssue[];
} {
	const directory = path.join(root, STAGE_FLOW_DIRECTORY);
	const entries: FlowRegistryEntry[] = [];
	const issues: FlowGenerationIssue[] = [];
	if (!fs.existsSync(directory)) return { entries, issues };
	for (const name of fs.readdirSync(directory).sort()) {
		const flowDir = path.join(directory, name);
		if (!fs.statSync(flowDir).isDirectory()) continue;
		const manifestPath = path.join(flowDir, "flow.json");
		if (!fs.existsSync(manifestPath)) {
			issues.push(
				issue(
					"flow-manifest-invalid",
					`stage-flows/${name} has no flow.json`,
					`stage-flows/${name}`,
				),
			);
			continue;
		}
		let parsed: ReturnType<typeof parseFlowManifest>;
		try {
			parsed = parseFlowManifest(
				JSON.parse(fs.readFileSync(manifestPath, "utf8")),
			);
		} catch (error) {
			issues.push(
				issue(
					"flow-manifest-invalid",
					`stage-flows/${name}/flow.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
					`stage-flows/${name}/flow.json`,
				),
			);
			continue;
		}
		if (parsed.manifest === undefined) {
			issues.push(...parsed.issues);
			continue;
		}
		if (parsed.manifest.flowId !== name)
			issues.push(
				issue(
					"flow-id-mismatch",
					`stage-flows/${name}/flow.json declares ${parsed.manifest.flowId}`,
					"flowId",
				),
			);
		const specPath = path.join(flowDir, "flow.spec.ts");
		if (!fs.existsSync(specPath)) {
			issues.push(
				issue(
					"flow-spec-missing",
					`stage-flows/${name} has no flow.spec.ts`,
					`stage-flows/${name}/flow.spec.ts`,
				),
			);
			continue;
		}
		const spec = fs.readFileSync(specPath, "utf8");
		if (canonicalHash(spec) !== parsed.manifest.specHash)
			issues.push(
				issue(
					"flow-spec-drift",
					`stage-flows/${name}/flow.spec.ts does not match its specHash`,
					`stage-flows/${name}/flow.spec.ts`,
				),
			);
		entries.push({
			manifest: parsed.manifest,
			spec,
			directory: flowDir,
			specPath,
		});
	}
	return { entries, issues };
}

export function flowManifestIssues(
	manifest: FlowManifest,
	registry: StageBlockRegistry,
): FlowGenerationIssue[] {
	const issues: FlowGenerationIssue[] = [];
	for (const step of manifest.routeSteps) {
		const block = registry.get(step.block);
		if (block === undefined) {
			issues.push(
				issue(
					"flow-block-unknown",
					`flow ${manifest.flowId} references unregistered block ${step.block}`,
					step.routeStepId,
				),
			);
			continue;
		}
		if (manifest.blockVersions[step.block] !== block.version)
			issues.push(
				issue(
					"flow-block-version",
					`flow ${manifest.flowId} pins ${step.block}@${manifest.blockVersions[step.block]}; the registry has ${block.version}`,
					step.routeStepId,
				),
			);
		if (manifest.blockDigests[step.block] !== blockDigest(block))
			issues.push(
				issue(
					"flow-block-digest",
					`flow ${manifest.flowId} pins a different source digest for ${step.block}@${block.version}`,
					step.routeStepId,
				),
			);
	}
	const declared =
		"type" in manifest.inputSchema && manifest.inputSchema.type === "object"
			? manifest.inputSchema.properties
			: {};
	for (const step of manifest.routeSteps)
		for (const name of step.inputs)
			if (!Object.hasOwn(declared, name))
				issues.push(
					issue(
						"flow-input-schema-mismatch",
						`flow ${manifest.flowId} step ${step.routeStepId} reads undeclared input ${name}`,
						name,
					),
				);
	return issues;
}

export function flowEligibility(options: {
	readonly flowId: string;
	readonly root: string;
	readonly stage: string;
	readonly source: FlowSource;
	readonly registry: StageBlockRegistry;
	readonly stages?: readonly string[];
	readonly apps?: Readonly<
		Record<string, { readonly roles?: readonly string[] }>
	>;
	readonly role?: string;
}): FlowEligibility {
	const issues: FlowGenerationIssue[] = [];
	const entry = readFlowRegistry(options.root).entries.find(
		(candidate) => candidate.manifest.flowId === options.flowId,
	);
	if (entry === undefined)
		return {
			eligible: false,
			issues: [
				issue(
					"flow-not-found",
					`flow ${options.flowId} is not saved under ${STAGE_FLOW_DIRECTORY}`,
					"flowId",
				),
			],
		};
	const manifest = entry.manifest;
	if (canonicalHash(entry.spec) !== manifest.specHash)
		issues.push(
			issue(
				"flow-spec-drift",
				`stage-flows/${manifest.flowId}/flow.spec.ts does not match its specHash`,
				`stage-flows/${manifest.flowId}/flow.spec.ts`,
			),
		);
	issues.push(...flowManifestIssues(manifest, options.registry));
	if (manifest.flowId !== options.source.flowId)
		issues.push(
			issue(
				"flow-id-mismatch",
				`approved flow id ${options.source.flowId} does not match ${manifest.flowId}`,
				"flowId",
			),
		);
	if (
		manifest.stage !== options.stage &&
		(manifest.stages === undefined || !manifest.stages.includes(options.stage))
	)
		issues.push(
			issue(
				"flow-stage-mismatch",
				`flow ${manifest.flowId} is saved for ${manifest.stage}, not ${options.stage}`,
				"stage",
			),
		);
	if (manifest.routeHash !== routeHashFor(options.source))
		issues.push(
			issue(
				"flow-route-drift",
				`the approved plan route differs from the saved ${manifest.flowId} route`,
			),
		);
	const contract = flowInputContract(options.source, options.registry);
	issues.push(...contract.issues);
	if (canonicalHash(contract.schema) !== canonicalHash(manifest.inputSchema))
		issues.push(
			issue(
				"flow-input-schema-mismatch",
				`the approved plan input schema differs from flow ${manifest.flowId}`,
				"inputs",
			),
		);
	const inputProblems = validateSchemaValue(
		manifest.inputSchema,
		options.source.inputs,
		"inputs",
	);
	for (const problem of inputProblems) {
		const missing = problem.code === "schema-required";
		issues.push(
			issue(
				missing ? "flow-inputs-missing" : "flow-inputs-invalid",
				problem.message,
				problem.path,
			),
		);
	}
	const declared =
		"type" in manifest.inputSchema && manifest.inputSchema.type === "object"
			? manifest.inputSchema.properties
			: {};
	for (const name of Object.keys(options.source.inputs))
		if (!Object.hasOwn(declared, name))
			issues.push(
				issue(
					"flow-inputs-extra",
					`flow ${manifest.flowId} does not declare input ${name}`,
					name,
				),
			);
	const expectedSteps = options.source.steps.map((step) =>
		routeStepProjection(
			step,
			options.source.routeMeta.find((meta) => meta.id === step.id),
		),
	);
	if (
		expectedSteps.length !== manifest.routeSteps.length ||
		expectedSteps.some(
			(step, index) =>
				canonicalHash(step) !== canonicalHash(manifest.routeSteps[index]),
		)
	)
		issues.push(
			issue(
				"flow-route-step-mismatch",
				`the approved plan route steps differ from flow ${manifest.flowId}`,
			),
		);
	const covered = new Set(
		manifest.routeSteps.flatMap((step) => step.expectationIds),
	);
	for (const expectation of options.source.expectations)
		if (!covered.has(expectation.id))
			issues.push(
				issue(
					"flow-expectation-uncovered",
					`expectation ${expectation.id} is not mapped to a replayable route step`,
					expectation.id,
				),
			);
	for (const step of options.source.steps) {
		const app = step.definition.app;
		if (app === "*") continue;
		const policyApp = options.apps?.[app];
		if (options.apps !== undefined && policyApp === undefined)
			issues.push(
				issue(
					"flow-app-missing",
					`stage ${options.stage} does not declare application ${app}`,
					step.id,
				),
			);
		if (
			options.role !== undefined &&
			(step.definition.roles ?? []).length > 0 &&
			!(step.definition.roles ?? []).includes(options.role)
		)
			issues.push(
				issue(
					"flow-role-missing",
					`block ${step.definition.id} is not approved for role ${options.role}`,
					step.id,
				),
			);
		if (
			options.role !== undefined &&
			policyApp?.roles !== undefined &&
			policyApp.roles.length > 0 &&
			!policyApp.roles.includes(options.role)
		)
			issues.push(
				issue(
					"flow-role-missing",
					`stage application ${app} does not declare role ${options.role}`,
					step.id,
				),
			);
	}
	return { eligible: issues.length === 0, issues };
}

export function compactFlowEntry(manifest: FlowManifest): {
	readonly flowId: string;
	readonly title: string;
	readonly stage: string;
	readonly applications: readonly string[];
	readonly roles: readonly string[];
	readonly routeHash: string;
	readonly specHash: string;
	readonly inputSchema: JsonSchema;
	readonly blockVersions: Readonly<Record<string, string>>;
} {
	return {
		flowId: manifest.flowId,
		title: manifest.title,
		stage: manifest.stage,
		applications: manifest.applications,
		roles: manifest.roles,
		routeHash: manifest.routeHash,
		specHash: manifest.specHash,
		inputSchema: manifest.inputSchema,
		blockVersions: manifest.blockVersions,
	};
}

export function sourceRouteSteps(source: FlowSource): readonly FlowRouteStep[] {
	return source.steps.map((step) =>
		routeStepProjection(
			step,
			source.routeMeta.find((meta) => meta.id === step.id),
		),
	);
}

export function normalizedPlanInputs(
	plan: NormalizedStageBlockPlan,
): Readonly<Record<string, JsonValue>> {
	return plan.inputs;
}
